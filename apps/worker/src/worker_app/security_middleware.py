# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 安全中间件
#
#   文件:       security_middleware.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""Worker 请求体上限、短期签名和并发门禁。"""

from __future__ import annotations

import asyncio
import logging
from typing import Protocol
from uuid import uuid4

from starlette.datastructures import Headers
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from worker_app.worker_auth import WorkerAuthVerifier


class ConcurrencyLimiter(Protocol):
    async def acquire(self) -> object: ...

    async def release(self, lease: object | None = None) -> None: ...


class WorkerSecurityMiddleware:
    """在 FastAPI 解析请求前完成有界读取、验签和并发控制。"""

    def __init__(
        self,
        app: ASGIApp,
        *,
        worker_auth: WorkerAuthVerifier,
        max_body_bytes: int,
        logger: logging.Logger,
        concurrency_limiter: ConcurrencyLimiter,
    ) -> None:
        self.app = app
        self.worker_auth = worker_auth
        self.max_body_bytes = max_body_bytes
        self.concurrency_limiter = concurrency_limiter
        self.logger = logger

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = str(scope.get("path") or "")
        headers = Headers(scope=scope)
        trace_id = headers.get("x-geo-agent-platform-trace-id") or uuid4().hex[:12]
        state = scope.setdefault("state", {})
        state["trace_id"] = trace_id
        if path in {"/health", "/health/live"}:
            await self.app(scope, receive, send)
            return

        content_length = _parse_content_length(headers.get("content-length"))
        if content_length is None and headers.get("content-length") is not None:
            await _send_json(scope, receive, send, 400, "Content-Length 必须是非负整数")
            return
        if content_length is not None and content_length > self.max_body_bytes:
            self.logger.warning(
                "Worker 请求体超过大小限制",
                extra={"event": "security.request_body.rejected", "category": "security", "retention": "operational", "trace_id": trace_id, "content_length": content_length, "limit": self.max_body_bytes},
            )
            await _send_json(scope, receive, send, 413, "Worker 请求体超过大小限制")
            return

        try:
            body = await _read_bounded_body(receive, self.max_body_bytes)
        except ClientDisconnect:
            # 不完整请求即使碰巧构成合法 JSON 也不能认证或进入执行队列。
            return
        if body is None:
            self.logger.warning(
                "Worker 请求体超过大小限制",
                extra={"event": "security.request_body.rejected", "category": "security", "retention": "operational", "trace_id": trace_id, "limit": self.max_body_bytes},
            )
            await _send_json(scope, receive, send, 413, "Worker 请求体超过大小限制")
            return

        tool_name = worker_auth_target(path)
        auth_error = self.worker_auth.verify(headers.get("authorization") or "", tool_name, body)
        if auth_error is not None:
            status_code, detail = auth_error
            self.logger.warning(
                "Worker 认证失败",
                extra={"event": "security.worker_auth.rejected", "category": "security", "retention": "operational", "trace_id": trace_id, "tool_name": tool_name, "status": status_code},
            )
            await _send_json(scope, receive, send, status_code, detail)
            return

        disconnected = asyncio.Event()
        replay_receive = _body_receiver(body, disconnected)

        async def watch_disconnect() -> None:
            # 请求体已读完；此任务是原始 ASGI receive 的唯一消费者，避免
            # 下游读取与断开监视器争抢 http.disconnect。
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    disconnected.set()
                    return

        async def serve_request() -> None:
            if disconnected.is_set():
                return
            lease = await self.concurrency_limiter.acquire()
            try:
                if not disconnected.is_set():
                    await self.app(scope, replay_receive, send)
            finally:
                await self.concurrency_limiter.release(lease)

        monitor = asyncio.create_task(watch_disconnect())
        request_task = asyncio.create_task(serve_request())
        try:
            done, _ = await asyncio.wait(
                (monitor, request_task), return_when=asyncio.FIRST_COMPLETED,
            )
            for task in done:
                task.result()
        finally:
            # 单次取消贯穿并发排队和科学计算。等执行器回收子进程、释放
            # 租约后才退出；不能再次 cancel 正在执行 finally 的请求任务。
            await _cancel_and_drain(monitor, request_task)


def worker_auth_target(path: str) -> str:
    if path == "/tools/catalog":
        return "catalog"
    parts = path.strip("/").split("/")
    if len(parts) == 2 and parts[0] == "tools" and parts[1]:
        return parts[1]
    return "unknown"


def _parse_content_length(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


async def _read_bounded_body(receive: Receive, limit: int) -> bytes | None:
    chunks = bytearray()
    more_body = True
    while more_body:
        message = await receive()
        if message["type"] == "http.disconnect":
            raise ClientDisconnect()
        if message["type"] != "http.request":
            continue
        chunks.extend(message.get("body", b""))
        if len(chunks) > limit:
            return None
        more_body = bool(message.get("more_body", False))
    return bytes(chunks)


def _body_receiver(body: bytes, disconnected: asyncio.Event) -> Receive:
    delivered = False

    async def receive() -> Message:
        nonlocal delivered
        if delivered:
            await disconnected.wait()
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return receive


async def _cancel_and_drain(*tasks: asyncio.Task[None]) -> None:
    for task in tasks:
        if not task.done() and not task.cancelling():
            task.cancel()
    cleanup = asyncio.gather(*tasks, return_exceptions=True)
    cancelled = False
    while not cleanup.done():
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            # 服务器关闭或第二次取消也不能打断正在回收的执行器。
            cancelled = True
    for result in cleanup.result():
        if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
            raise result
    if cancelled:
        raise asyncio.CancelledError()


async def _send_json(
    scope: Scope,
    receive: Receive,
    send: Send,
    status_code: int,
    detail: str,
) -> None:
    await JSONResponse({"detail": detail}, status_code=status_code)(scope, receive, send)

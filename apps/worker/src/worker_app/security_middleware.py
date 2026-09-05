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

import logging
from typing import Protocol
from uuid import uuid4

from starlette.datastructures import Headers
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

        body = await _read_bounded_body(receive, self.max_body_bytes)
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

        replay_receive = _body_receiver(body)
        lease = await self.concurrency_limiter.acquire()
        try:
            await self.app(scope, replay_receive, send)
        finally:
            await self.concurrency_limiter.release(lease)


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
            return bytes(chunks)
        if message["type"] != "http.request":
            continue
        chunks.extend(message.get("body", b""))
        if len(chunks) > limit:
            return None
        more_body = bool(message.get("more_body", False))
    return bytes(chunks)


def _body_receiver(body: bytes) -> Receive:
    delivered = False

    async def receive() -> Message:
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return receive


async def _send_json(
    scope: Scope,
    receive: Receive,
    send: Send,
    status_code: int,
    detail: str,
) -> None:
    await JSONResponse({"detail": detail}, status_code=status_code)(scope, receive, send)

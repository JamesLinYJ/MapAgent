# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 防重放与取消生命周期回归
#
#   文件:       test_worker_review_regressions.py
#   日期:       2026年09月08日
#   协助:       OpenAI ChatGPT
# --------------------------------------------------------------------------

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
from pathlib import Path
import sys
import time

import pytest
from fastapi import FastAPI
from pydantic import BaseModel

WORKER_SRC = Path(__file__).resolve().parents[1] / "src"
if str(WORKER_SRC) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC))

from worker_app import worker_auth
from worker_app.execution import ProcessToolExecutor
from worker_app.lifecycle import SqliteConcurrencyLimiter
from worker_app.path_sandbox import WorkerPathSandbox
from worker_app.security_middleware import WorkerSecurityMiddleware
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry
from worker_app.tool_routes import register_tool_routes
from worker_app.worker_auth import WorkerAuthConfig, WorkerAuthVerifier

SECRET = "review-test-secret-not-a-real-credential"


def signed(body: bytes, nonce: str, *, now: int, exp: int) -> str:
    payload = json.dumps({"v": 1, "toolName": "delay", "iat": now, "exp": exp,
                          "nonce": nonce, "bodyHash": hashlib.sha256(body).hexdigest()}).encode()
    encoded = base64.urlsafe_b64encode(payload).rstrip(b"=")
    signature = hmac.new(SECRET.encode(), encoded, hashlib.sha256).digest()
    return "GeoAgentPlatform-Worker " + encoded.decode() + "." + base64.urlsafe_b64encode(signature).rstrip(b"=").decode()


def scope_for(body: bytes, nonce: str = "review-request-nonce-0001") -> dict:
    now = int(time.time())
    return {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "POST", "scheme": "http", "path": "/tools/delay", "raw_path": b"/tools/delay",
            "query_string": b"", "root_path": "", "server": ("test", 80), "client": ("127.0.0.1", 1),
            "headers": [(b"content-type", b"application/json"),
                        (b"authorization", signed(body, nonce, now=now, exp=now + 300).encode())]}


def middleware(app, limiter):
    return WorkerSecurityMiddleware(app, worker_auth=WorkerAuthVerifier(WorkerAuthConfig(shared_secret=SECRET)),
                                    max_body_bytes=4096, logger=logging.getLogger("worker-test"), concurrency_limiter=limiter)


@pytest.mark.parametrize("persistent", [False, True])
def test_live_nonces_survive_capacity_pressure_and_expiry_boundary(tmp_path, monkeypatch, persistent):
    now = 2_000_000_000
    monkeypatch.setattr(worker_auth.time, "time", lambda: now)
    config = WorkerAuthConfig(shared_secret=SECRET, nonce_cache_max=2,
                             nonce_store_path=tmp_path / "nonces.sqlite3" if persistent else None)
    first = WorkerAuthVerifier(config)
    second = WorkerAuthVerifier(config) if persistent else first
    body = b"{}"
    a = signed(body, "review-live-nonce-a", now=now, exp=now + 60)
    b = signed(body, "review-live-nonce-b", now=now, exp=now + 120)
    c = signed(body, "review-live-nonce-c", now=now, exp=now + 180)
    assert first.verify(a, "delay", body) is None
    assert second.verify(b, "delay", body) is None
    # exp == now is still accepted by the signature contract, so its nonce must remain protected.
    now += 60
    overflow = second.verify(c, "delay", body)
    assert overflow is not None and overflow[0] == 503
    assert first.verify(a, "delay", body) == (403, "Worker 授权 nonce 已使用")
    assert second.verify(b, "delay", body) == (403, "Worker 授权 nonce 已使用")
    assert first.nonce_cache_size == 2
    now += 1
    assert second.verify(c, "delay", body) is None
    assert first.verify(b, "delay", body) == (403, "Worker 授权 nonce 已使用")
    assert first.nonce_cache_size == 2


class RecordingLimiter:
    def __init__(self, *, blocked=False):
        self.blocked = blocked
        self.entered = asyncio.Event()
        self.released = asyncio.Event()
        self.active = 0

    async def acquire(self):
        self.entered.set()
        if self.blocked:
            await asyncio.Event().wait()
        self.active += 1
        return object()

    async def release(self, lease=None):
        assert lease is not None
        self.active -= 1
        self.released.set()


async def drain(task):
    if not task.done():
        task.cancel()
    await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_disconnect_during_body_read_never_authenticates_or_executes():
    body = b'{"args":{}}'
    incoming = asyncio.Queue()
    incoming.put_nowait({"type": "http.request", "body": body, "more_body": True})
    incoming.put_nowait({"type": "http.disconnect"})
    calls = []
    async def app(*_args):
        calls.append("executed")
    async def send(_message):
        calls.append("sent")
    limiter = RecordingLimiter()
    boundary = middleware(app, limiter)
    await boundary(scope_for(body), incoming.get, send)
    assert calls == []
    assert not limiter.entered.is_set()
    assert boundary.worker_auth.nonce_cache_size == 0


@pytest.mark.asyncio
async def test_disconnect_cancels_wait_for_global_lease(tmp_path):
    limiter = SqliteConcurrencyLimiter(tmp_path / "leases.sqlite3", 1, lease_ttl_seconds=60)
    held = await limiter.acquire()
    calls = []
    body = b'{"args":{}}'
    incoming = asyncio.Queue()
    incoming.put_nowait({"type": "http.request", "body": body, "more_body": False})
    async def app(*_args):
        calls.append("executed")
    async def send(_message):
        calls.append("sent")
    task = asyncio.create_task(middleware(app, limiter)(scope_for(body), incoming.get, send))
    try:
        incoming.put_nowait({"type": "http.disconnect"})
        done, _ = await asyncio.wait({task}, timeout=0.5)
        assert task in done, "disconnected request stayed in the global concurrency queue"
        task.result()
        assert calls == []
    finally:
        await drain(task)
        await limiter.release(held)
    # No orphan lease may prevent the next request from entering.
    lease = await asyncio.wait_for(limiter.acquire(), timeout=1)
    await limiter.release(lease)


class DelayArgs(BaseModel):
    seconds: float


def marked_delay(args: dict, context: WorkerToolContext) -> dict:
    root = context.path_sandbox.runtime_root
    (root / "started").write_text("started")
    time.sleep(args["seconds"])
    (root / "completed").write_text("completed")
    return {"completed": True}


@pytest.mark.asyncio
async def test_http_disconnect_terminates_science_process_and_releases_lease(tmp_path):
    registry = WorkerToolRegistry()
    registry.register("delay", marked_delay, request_model=DelayArgs)
    executor = ProcessToolExecutor(registry)
    context = WorkerToolContext(WorkerPathSandbox(tmp_path))
    limiter = RecordingLimiter()
    app = FastAPI()
    register_tool_routes(app, tool_timeout_seconds=30, logger=logging.getLogger("worker-test"),
                         tool_context=context, tool_executor=executor)
    body = b'{"args":{"seconds":20}}'
    incoming = asyncio.Queue()
    incoming.put_nowait({"type": "http.request", "body": body, "more_body": False})
    sent = []
    async def send(message):
        sent.append(message)
    task = None
    try:
        await executor.start()
        slot = next(iter(executor._slots))
        task = asyncio.create_task(middleware(app, limiter)(scope_for(body), incoming.get, send))
        async def started():
            while not (tmp_path / "started").exists():
                await asyncio.sleep(0.01)
        await asyncio.wait_for(started(), timeout=5)
        incoming.put_nowait({"type": "http.disconnect"})
        done, _ = await asyncio.wait({task}, timeout=1)
        assert task in done, "disconnected request left its scientific process running"
        task.result()
        assert slot.stopped
        assert limiter.active == 0 and limiter.released.is_set()
        assert not (tmp_path / "completed").exists()
        assert sent == []
        assert await executor.execute("delay", {"seconds": 0}, context, timeout_seconds=5) == {"completed": True}
    finally:
        if task is not None:
            await drain(task)
        await executor.shutdown()


@pytest.mark.asyncio
async def test_slot_is_returned_when_cancelled_during_handoff_cleanup():
    executor = ProcessToolExecutor(WorkerToolRegistry())
    slot = object()
    executor._slots.add(slot)
    waiting = asyncio.Event()
    cleaning = asyncio.Event()
    release_cleanup = asyncio.Event()
    class SlowCloseEvent(asyncio.Event):
        async def wait(self):
            waiting.set()
            try:
                return await super().wait()
            finally:
                cleaning.set()
                await release_cleanup.wait()
    executor._closed_event = SlowCloseEvent()
    task = asyncio.create_task(executor._acquire_slot())
    try:
        await asyncio.wait_for(waiting.wait(), timeout=1)
        executor._queue().put_nowait(slot)
        await asyncio.wait_for(cleaning.wait(), timeout=1)
        task.cancel()
        release_cleanup.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert executor._queue().qsize() == 1, "slot lost between queue.get and the caller"
        assert executor._queue().get_nowait() is slot
    finally:
        release_cleanup.set()
        await drain(task)
        executor._slots.clear()

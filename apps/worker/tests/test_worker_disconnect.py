# +-------------------------------------------------------------------------
#   地理智能平台 - Worker HTTP 取消生命周期回归测试
#   文件: test_worker_disconnect.py
#   日期: 2026年09月08日
#   AI 协助: OpenAI ChatGPT (GPT-6 Astra Pro)
# --------------------------------------------------------------------------

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "apps/worker/src"))
from worker_app.security_middleware import WorkerSecurityMiddleware, _body_receiver


class Verifier:
    def __init__(self):
        self.calls = 0

    def verify(self, _authorization, _tool_name, _body):
        self.calls += 1
        return None


class Limiter:
    def __init__(self, blocked=False):
        self.blocked = blocked
        self.entered = asyncio.Event()
        self.cancelled = False
        self.lease = object()
        self.released = []

    async def acquire(self):
        self.entered.set()
        if self.blocked:
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        return self.lease

    async def release(self, lease=None):
        self.released.append(lease)


class WorkerDisconnectTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.incoming = asyncio.Queue()
        self.sent = []
        self.verifier = Verifier()
        self.limiter = Limiter()
        self.scope = {"type": "http", "method": "POST", "path": "/tools/test",
                      "headers": [(b"content-type", b"application/json")]}
        self.incoming.put_nowait({"type": "http.request", "body": b'{}', "more_body": False})

    def start(self, app):
        middleware = WorkerSecurityMiddleware(app, worker_auth=self.verifier,
            max_body_bytes=1024, logger=logging.getLogger("disconnect-test"),
            concurrency_limiter=self.limiter)

        async def send(message):
            self.sent.append(message)

        return asyncio.create_task(middleware(self.scope, self.incoming.get, send))

    async def finish(self, task):
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=0.5)
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_disconnect_cancels_running_work_and_releases_lease(self):
        started, stopped = asyncio.Event(), asyncio.Event()

        async def app(_scope, receive, _send):
            self.assertEqual((await receive())["body"], b'{}')
            started.set()
            try:
                await asyncio.Future()
            finally:
                # Exercise asynchronous executor teardown, not just a flag.
                await asyncio.sleep(0)
                stopped.set()

        task = self.start(app)
        await asyncio.wait_for(started.wait(), 0.5)
        self.incoming.put_nowait({"type": "http.disconnect"})
        await self.finish(task)
        self.assertTrue(stopped.is_set())
        self.assertEqual(self.limiter.released, [self.limiter.lease])
        self.assertEqual(self.sent, [])

    async def test_disconnect_cancels_waiting_admission_without_starting_app(self):
        self.limiter = Limiter(blocked=True)
        called = False

        async def app(_scope, _receive, _send):
            nonlocal called
            called = True

        task = self.start(app)
        await asyncio.wait_for(self.limiter.entered.wait(), 0.5)
        self.incoming.put_nowait({"type": "http.disconnect"})
        await self.finish(task)
        self.assertTrue(self.limiter.cancelled)
        self.assertFalse(called)
        self.assertEqual(self.limiter.released, [])

    async def test_incomplete_disconnected_body_is_not_authenticated_or_dispatched(self):
        self.incoming.get_nowait()
        self.incoming.put_nowait({"type": "http.request", "body": b'{', "more_body": True})
        self.incoming.put_nowait({"type": "http.disconnect"})
        called = False

        async def app(_scope, _receive, _send):
            nonlocal called
            called = True

        await self.finish(self.start(app))
        self.assertEqual(self.verifier.calls, 0)
        self.assertFalse(called)
        self.assertFalse(self.limiter.entered.is_set())

    async def test_response_completion_does_not_leave_a_disconnect_reader(self):
        async def app(_scope, receive, send):
            self.assertEqual((await receive())["body"], b'{}')
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b'ok'})

        tasks_before = asyncio.all_tasks()
        await self.finish(self.start(app))
        self.assertEqual(self.sent[-1]["body"], b'ok')
        self.assertEqual(self.limiter.released, [self.limiter.lease])
        self.assertFalse(asyncio.all_tasks() - tasks_before)

    async def test_outer_cancellation_waits_for_cleanup_and_is_not_swallowed(self):
        started, stopped = asyncio.Event(), asyncio.Event()

        async def app(_scope, _receive, _send):
            started.set()
            try:
                await asyncio.Future()
            finally:
                await asyncio.sleep(0)
                stopped.set()

        task = self.start(app)
        await asyncio.wait_for(started.wait(), 0.5)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(stopped.is_set())
        self.assertEqual(self.limiter.released, [self.limiter.lease])

    async def test_replayed_body_is_followed_by_real_disconnect_not_empty_requests(self):
        disconnected = asyncio.Event()
        receive = _body_receiver(b'{}', disconnected)
        self.assertEqual(await receive(), {"type": "http.request", "body": b'{}', "more_body": False})
        next_message = asyncio.create_task(receive())
        await asyncio.sleep(0)
        self.assertFalse(next_message.done())
        disconnected.set()
        self.assertEqual(await next_message, {"type": "http.disconnect"})
        self.assertEqual(await receive(), {"type": "http.disconnect"})


if __name__ == "__main__":
    unittest.main()

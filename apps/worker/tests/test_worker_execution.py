# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 子进程执行边界测试
#
#   文件:       test_worker_execution.py
#
#   日期:       2026年08月03日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5
# --------------------------------------------------------------------------

"""验证 Worker 工具超时会终止子进程，而不是遗留后台线程。"""

from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
import hashlib
import hmac
import json
import logging
import os
import time
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_SRC = REPO_ROOT / "apps" / "worker" / "src"
if str(WORKER_SRC) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC))

from worker_app.execution import ProcessToolExecutor, WorkerToolExecutionError, WorkerToolTimeoutError
from worker_app.path_sandbox import WorkerPathSandbox
from worker_app.app_factory import create_worker_app
from worker_app.settings import WorkerSettings
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry
from worker_app.tool_routes import register_tool_routes


class DelayRequest(BaseModel):
    seconds: float


_PROCESS_MUTATION = 0


def delay_tool(args: dict, _context: WorkerToolContext) -> dict:
    time.sleep(args["seconds"])
    return {"completed": True}


def process_identity_tool(args: dict, _context: WorkerToolContext) -> dict:
    time.sleep(args["seconds"])
    return {"pid": os.getpid()}


def poison_process_tool(args: dict, _context: WorkerToolContext) -> dict:
    global _PROCESS_MUTATION
    time.sleep(args["seconds"])
    _PROCESS_MUTATION += 1
    raise RuntimeError("injected worker failure")


def process_state_tool(args: dict, _context: WorkerToolContext) -> dict:
    time.sleep(args["seconds"])
    return {"pid": os.getpid(), "mutation": _PROCESS_MUTATION}


def exit_process_tool(args: dict, _context: WorkerToolContext) -> dict:
    time.sleep(args["seconds"])
    raise SystemExit(3)


class WorkerExecutionTests(unittest.TestCase):
    def _executor(
        self,
        *,
        pool_size: int = 1,
    ) -> tuple[ProcessToolExecutor, WorkerToolContext, tempfile.TemporaryDirectory]:
        registry = WorkerToolRegistry()
        registry.register("delay", delay_tool, request_model=DelayRequest)
        registry.register("identity", process_identity_tool, request_model=DelayRequest)
        registry.register("poison", poison_process_tool, request_model=DelayRequest)
        registry.register("state", process_state_tool, request_model=DelayRequest)
        registry.register("exit", exit_process_tool, request_model=DelayRequest)
        directory = tempfile.TemporaryDirectory()
        context = WorkerToolContext(WorkerPathSandbox(Path(directory.name)))
        return ProcessToolExecutor(registry, pool_size=pool_size), context, directory

    def test_successful_tool_runs_in_child_process(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> dict:
            try:
                return await executor.execute("delay", {"seconds": 0.01}, context, timeout_seconds=5)
            finally:
                await executor.shutdown()

        try:
            result = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertEqual(result, {"completed": True})

    def test_cancelling_partial_pool_start_reclaims_started_processes(self) -> None:
        executor, _context, directory = self._executor(pool_size=2)

        async def scenario() -> None:
            original_spawn = executor._spawn_slot
            first_ready = asyncio.Event()
            never_ready = asyncio.Event()
            spawned = []
            call_index = 0

            async def controlled_spawn():
                nonlocal call_index
                index = call_index
                call_index += 1
                if index == 1:
                    await never_ready.wait()
                slot = await original_spawn()
                spawned.append(slot)
                first_ready.set()
                return slot

            executor._spawn_slot = controlled_spawn
            start_task = asyncio.create_task(executor.start())
            await asyncio.wait_for(first_ready.wait(), timeout=5)
            start_task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await start_task
            self.assertEqual(len(spawned), 1)
            self.assertTrue(spawned[0].stopped)
            await executor.shutdown()

        try:
            asyncio.run(scenario())
        finally:
            directory.cleanup()

    def test_successive_tools_reuse_the_same_warm_process(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> tuple[dict, dict]:
            try:
                first = await executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                second = await executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                return first, second
            finally:
                await executor.shutdown()

        try:
            first, second = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertEqual(first["pid"], second["pid"])

    def test_invalid_request_does_not_recycle_a_healthy_process(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> tuple[int, int, WorkerToolExecutionError]:
            try:
                before = await executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                error: WorkerToolExecutionError | None = None
                try:
                    await executor.execute(
                        "delay",
                        {"seconds": "not-a-number"},
                        context,
                        timeout_seconds=5,
                    )
                except WorkerToolExecutionError as exc:
                    error = exc
                if error is None:
                    raise AssertionError("无效参数必须被 Worker 执行边界拒绝")
                after = await executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                return int(before["pid"]), int(after["pid"]), error
            finally:
                await executor.shutdown()

        try:
            before_pid, after_pid, error = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertTrue(error.invalid_request)
        self.assertEqual(before_pid, after_pid)

    def test_failed_tool_discards_process_state_before_the_next_request(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> tuple[int, dict]:
            try:
                before = await executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                with self.assertRaises(WorkerToolExecutionError) as raised:
                    await executor.execute("poison", {"seconds": 0}, context, timeout_seconds=5)
                self.assertFalse(raised.exception.invalid_request)
                after = await executor.execute("state", {"seconds": 0}, context, timeout_seconds=5)
                return int(before["pid"]), after
            finally:
                await executor.shutdown()

        try:
            before_pid, after = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertNotEqual(before_pid, after["pid"])
        self.assertEqual(after["mutation"], 0)

    def test_base_exception_terminates_and_replaces_the_process(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> tuple[int, int]:
            try:
                before = await executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                with self.assertRaises(WorkerToolExecutionError):
                    await executor.execute("exit", {"seconds": 0}, context, timeout_seconds=5)
                after = await executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                return int(before["pid"]), int(after["pid"])
            finally:
                await executor.shutdown()

        try:
            before_pid, after_pid = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertNotEqual(before_pid, after_pid)

    def test_pool_runs_two_tools_in_parallel_without_spawning_per_call(self) -> None:
        executor, context, directory = self._executor(pool_size=2)

        async def scenario() -> tuple[dict, dict]:
            try:
                first, second = await asyncio.gather(
                    executor.execute("identity", {"seconds": 0.1}, context, timeout_seconds=5),
                    executor.execute("identity", {"seconds": 0.1}, context, timeout_seconds=5),
                )
                return first, second
            finally:
                await executor.shutdown()

        try:
            first, second = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertNotEqual(first["pid"], second["pid"])

    def test_timeout_terminates_child_process(self) -> None:
        executor, context, directory = self._executor()
        started = time.perf_counter()

        async def scenario() -> None:
            try:
                await executor.start()
                await executor.execute("delay", {"seconds": 5}, context, timeout_seconds=0.1)
            finally:
                await executor.shutdown()

        try:
            with self.assertRaises(WorkerToolTimeoutError):
                asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertLess(time.perf_counter() - started, 2, "超时后不得遗留执行线程或进程")

    def test_timeout_discards_the_busy_process_and_replaces_it_on_demand(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> tuple[int, int]:
            try:
                before = await executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                with self.assertRaises(WorkerToolTimeoutError):
                    await executor.execute("delay", {"seconds": 5}, context, timeout_seconds=0.1)
                after = await executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                return int(before["pid"]), int(after["pid"])
            finally:
                await executor.shutdown()

        try:
            before_pid, after_pid = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertNotEqual(before_pid, after_pid)

    def test_waiting_tool_replaces_a_process_discarded_by_timeout(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> dict:
            try:
                await executor.start()
                timed_out = asyncio.create_task(
                    executor.execute("delay", {"seconds": 5}, context, timeout_seconds=0.1)
                )
                await asyncio.sleep(0.02)
                waiting = asyncio.create_task(
                    executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                )
                with self.assertRaises(WorkerToolTimeoutError):
                    await timed_out
                return await asyncio.wait_for(waiting, timeout=5)
            finally:
                await executor.shutdown()

        try:
            result = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertIsInstance(result["pid"], int)

    def test_timeout_includes_time_waiting_for_a_pool_slot(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> float:
            try:
                await executor.start()
                active = asyncio.create_task(
                    executor.execute("identity", {"seconds": 0.5}, context, timeout_seconds=5)
                )
                await asyncio.sleep(0.02)
                started = time.perf_counter()
                with self.assertRaises(WorkerToolTimeoutError):
                    await executor.execute(
                        "identity",
                        {"seconds": 0},
                        context,
                        timeout_seconds=0.05,
                    )
                elapsed = time.perf_counter() - started
                await active
                return elapsed
            finally:
                await executor.shutdown()

        try:
            elapsed = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertLess(elapsed, 0.25, "工具超时不得从取得进程槽后才开始计时")

    def test_cancelled_replacement_hands_capacity_to_the_next_waiter(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> dict:
            try:
                await executor.start()
                original_spawn = executor._spawn_slot
                replacement_started = asyncio.Event()
                never_ready = asyncio.Event()
                call_index = 0

                async def controlled_spawn():
                    nonlocal call_index
                    index = call_index
                    call_index += 1
                    if index == 0:
                        replacement_started.set()
                        await never_ready.wait()
                    return await original_spawn()

                executor._spawn_slot = controlled_spawn
                timed_out = asyncio.create_task(
                    executor.execute("delay", {"seconds": 5}, context, timeout_seconds=0.1)
                )
                await asyncio.sleep(0.02)
                first_waiter = asyncio.create_task(
                    executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                )
                await asyncio.sleep(0)
                second_waiter = asyncio.create_task(
                    executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                )
                with self.assertRaises(WorkerToolTimeoutError):
                    await timed_out
                await asyncio.wait_for(replacement_started.wait(), timeout=5)
                first_waiter.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first_waiter
                return await asyncio.wait_for(second_waiter, timeout=5)
            finally:
                await executor.shutdown()

        try:
            result = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertIsInstance(result["pid"], int)

    def test_failed_replacement_hands_capacity_to_the_next_waiter(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> tuple[BaseException, dict]:
            try:
                await executor.start()
                original_spawn = executor._spawn_slot
                replacement_started = asyncio.Event()
                fail_replacement = asyncio.Event()
                call_index = 0

                async def controlled_spawn():
                    nonlocal call_index
                    index = call_index
                    call_index += 1
                    if index == 0:
                        replacement_started.set()
                        await fail_replacement.wait()
                        raise WorkerToolExecutionError("注入的执行槽启动失败")
                    return await original_spawn()

                executor._spawn_slot = controlled_spawn
                timed_out = asyncio.create_task(
                    executor.execute("delay", {"seconds": 5}, context, timeout_seconds=0.1)
                )
                await asyncio.sleep(0.02)
                first_waiter = asyncio.create_task(
                    executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                )
                await asyncio.sleep(0)
                second_waiter = asyncio.create_task(
                    executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                )
                with self.assertRaises(WorkerToolTimeoutError):
                    await timed_out
                await asyncio.wait_for(replacement_started.wait(), timeout=5)
                fail_replacement.set()
                first_result = (await asyncio.gather(first_waiter, return_exceptions=True))[0]
                assert isinstance(first_result, BaseException)
                second_result = await asyncio.wait_for(second_waiter, timeout=5)
                return first_result, second_result
            finally:
                await executor.shutdown()

        try:
            first_error, result = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertIsInstance(first_error, WorkerToolExecutionError)
        self.assertIsInstance(result["pid"], int)

    def test_cancelling_a_waiter_does_not_lose_the_available_slot(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> tuple[int, int]:
            try:
                await executor.start()
                active = asyncio.create_task(
                    executor.execute("identity", {"seconds": 0.15}, context, timeout_seconds=5)
                )
                await asyncio.sleep(0.02)
                waiting = asyncio.create_task(
                    executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5)
                )
                await asyncio.sleep(0.05)
                waiting.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await waiting
                first = await active
                second = await asyncio.wait_for(
                    executor.execute("identity", {"seconds": 0}, context, timeout_seconds=5),
                    timeout=5,
                )
                return int(first["pid"]), int(second["pid"])
            finally:
                await executor.shutdown()

        try:
            first_pid, second_pid = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertEqual(first_pid, second_pid)

    def test_route_returns_504_after_child_is_terminated(self) -> None:
        registry = WorkerToolRegistry()
        registry.register("delay", delay_tool, request_model=DelayRequest)
        directory = tempfile.TemporaryDirectory()
        executor = ProcessToolExecutor(registry)

        @asynccontextmanager
        async def lifespan(_app: FastAPI):
            await executor.start()
            try:
                yield
            finally:
                await executor.shutdown()

        app = FastAPI(lifespan=lifespan)
        try:
            register_tool_routes(
                app,
                tool_timeout_seconds=0.1,
                logger=logging.getLogger("worker.test.execution"),
                tool_context=WorkerToolContext(WorkerPathSandbox(Path(directory.name))),
                tool_executor=executor,
            )
            with TestClient(app) as client:
                response = client.post("/tools/delay", json={"args": {"seconds": 5}})
        finally:
            directory.cleanup()
        self.assertEqual(response.status_code, 504)

    def test_request_cancellation_terminates_child_process(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> None:
            try:
                await executor.start()
                task = asyncio.create_task(
                    executor.execute("delay", {"seconds": 5}, context, timeout_seconds=10)
                )
                await asyncio.sleep(0.1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            finally:
                await executor.shutdown()

        started = time.perf_counter()
        try:
            asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertLess(time.perf_counter() - started, 2, "取消请求后不得遗留 Worker 子进程")

    def test_shutdown_terminates_active_child_processes(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> None:
            await executor.start()
            task = asyncio.create_task(
                executor.execute("delay", {"seconds": 5}, context, timeout_seconds=10)
            )
            await asyncio.sleep(0.1)
            await executor.shutdown()
            with self.assertRaises(WorkerToolExecutionError):
                await task

        try:
            asyncio.run(scenario())
        finally:
            directory.cleanup()

    def test_shutdown_releases_tools_waiting_for_a_pool_slot(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> tuple[BaseException, BaseException]:
            await executor.start()
            active = asyncio.create_task(
                executor.execute("delay", {"seconds": 5}, context, timeout_seconds=10)
            )
            await asyncio.sleep(0.05)
            waiting = asyncio.create_task(
                executor.execute("identity", {"seconds": 0}, context, timeout_seconds=10)
            )
            await asyncio.sleep(0.05)
            await executor.shutdown()
            active_result, waiting_result = await asyncio.gather(
                active,
                waiting,
                return_exceptions=True,
            )
            assert isinstance(active_result, BaseException)
            assert isinstance(waiting_result, BaseException)
            return active_result, waiting_result

        try:
            active_error, waiting_error = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertIsInstance(active_error, WorkerToolExecutionError)
        self.assertIsInstance(waiting_error, WorkerToolExecutionError)

    def test_cancelled_and_concurrent_shutdowns_share_complete_cleanup(self) -> None:
        executor, context, directory = self._executor()

        async def scenario() -> tuple[BaseException, object, BaseException]:
            await executor.start()
            active = asyncio.create_task(
                executor.execute("delay", {"seconds": 5}, context, timeout_seconds=10)
            )
            await asyncio.sleep(0.05)
            first_shutdown = asyncio.create_task(executor.shutdown())
            await asyncio.sleep(0)
            second_shutdown = asyncio.create_task(executor.shutdown())
            first_shutdown.cancel()
            first_result, second_result = await asyncio.gather(
                first_shutdown,
                second_shutdown,
                return_exceptions=True,
            )
            active_result = await asyncio.gather(active, return_exceptions=True)
            assert isinstance(first_result, BaseException)
            assert isinstance(active_result[0], BaseException)
            return first_result, second_result, active_result[0]

        try:
            cancelled_error, second_result, active_error = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertIsInstance(cancelled_error, asyncio.CancelledError)
        self.assertIsNone(second_result)
        self.assertIsInstance(active_error, WorkerToolExecutionError)

    def test_shutdown_reports_cleanup_failure_and_retries_the_slot(self) -> None:
        executor, _context, directory = self._executor()

        async def scenario() -> tuple[bool, bool, bool]:
            await executor.start()
            slot = next(iter(executor._slots))
            original_stop_process = executor._stop_process
            attempts = 0

            def fail_once(process) -> None:
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    raise RuntimeError("injected process cleanup failure")
                original_stop_process(process)

            executor._stop_process = fail_once
            with self.assertRaises(WorkerToolExecutionError):
                await executor.shutdown()
            first_stopped = slot.stopped
            connection_closed = slot.connection.closed
            await executor.shutdown()
            return first_stopped, connection_closed, slot.stopped

        try:
            first_stopped, connection_closed, retried_stopped = asyncio.run(scenario())
        finally:
            directory.cleanup()
        self.assertFalse(first_stopped)
        self.assertTrue(connection_closed)
        self.assertTrue(retried_stopped)

    def test_production_app_wires_auth_limiter_and_process_executor(self) -> None:
        secret = "integration-worker-secret"
        with tempfile.TemporaryDirectory() as directory:
            environment = {
                "RUNTIME_ROOT": directory,
                "WORKER_SHARED_SECRET": secret,
                "WORKER_MAX_CONCURRENCY": "1",
                "WORKER_TOOL_TIMEOUT_SECONDS": "10",
                "WORKER_CONCURRENCY_LEASE_SECONDS": "11",
            }
            with patch.dict(os.environ, environment, clear=False):
                app = create_worker_app(WorkerSettings.from_env())
            body = b'{"args":{}}'
            auth = _sign_request("recommend_radar_mosaic_strategy", body, secret)
            with TestClient(app) as client:
                response = client.post(
                    "/tools/recommend_radar_mosaic_strategy",
                    content=body,
                    headers={"content-type": "application/json", "authorization": auth},
                )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["payload"]["goalMode"], "quicklook")

    def test_app_lifespan_cleans_up_after_executor_start_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            environment = {
                "RUNTIME_ROOT": directory,
                "WORKER_MAX_CONCURRENCY": "1",
            }
            with patch.dict(os.environ, environment, clear=False):
                app = create_worker_app(WorkerSettings.from_env())
            executor = app.state.tool_executor

            async def scenario() -> bool:
                shutdown_called = False

                async def fail_start() -> None:
                    raise RuntimeError("injected startup failure")

                async def record_shutdown() -> None:
                    nonlocal shutdown_called
                    shutdown_called = True

                executor.start = fail_start
                executor.shutdown = record_shutdown
                with self.assertRaisesRegex(RuntimeError, "injected startup failure"):
                    async with app.router.lifespan_context(app):
                        pass
                return shutdown_called

            self.assertTrue(asyncio.run(scenario()))


def _sign_request(tool_name: str, body: bytes, secret: str) -> str:
    now = int(time.time())
    payload = {
        "v": 1,
        "toolName": tool_name,
        "iat": now,
        "exp": now + 60,
        "nonce": f"integration-nonce-{now}-{hashlib.sha256(body).hexdigest()[:12]}",
        "bodyHash": hashlib.sha256(body).hexdigest(),
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    signature = hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
    return f"GeoAgentPlatform-Worker {encoded}.{encoded_signature}"


if __name__ == "__main__":
    unittest.main()

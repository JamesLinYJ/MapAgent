# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 工具进程执行边界
#
#   文件:       execution.py
#
#   日期:       2026年08月03日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5
# --------------------------------------------------------------------------

"""在可回收的子进程中执行科学计算。

科学计算可能进入原生库或不可取消的 Python 调用。将其放在
``asyncio.to_thread`` 中无法在超时后终止底层线程，因此本模块使用有界的
预热子进程池；正常调用复用进程，超时、取消或关闭时仍可终止对应进程。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import multiprocessing
from pathlib import Path
import threading
import traceback
from typing import Any, Protocol
from uuid import uuid4

from worker_app.path_sandbox import WorkerPathSandbox
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry


class WorkerToolExecutor(Protocol):
    async def execute(
        self,
        tool_name: str,
        args: dict[str, Any],
        context: WorkerToolContext,
        *,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        """执行工具，并在超时或取消时释放执行资源。"""


class WorkerToolTimeoutError(TimeoutError):
    """科学计算子进程已被超时终止。"""


class WorkerToolExecutionError(RuntimeError):
    """子进程返回了不可公开的执行错误。"""

    def __init__(self, message: str, *, invalid_request: bool = False) -> None:
        super().__init__(message)
        self.invalid_request = invalid_request


@dataclass(frozen=True, slots=True)
class ProcessExecutionOptions:
    poll_interval_seconds: float = 0.02
    terminate_grace_seconds: float = 0.5
    startup_timeout_seconds: float = 15.0


@dataclass(eq=False, slots=True)
class _ProcessSlot:
    process: multiprocessing.Process
    connection: Any
    stop_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    stopped: bool = False


class InProcessToolExecutor:
    """仅供单元测试和显式本地调用使用的直接执行器。

    生产应用必须注入 :class:`ProcessToolExecutor`。保留该实现可以让路由
    测试使用 lambda 或测试替身，而不会把测试注册表强行要求为可 pickle。
    """

    def __init__(self, registry: WorkerToolRegistry) -> None:
        self.registry = registry

    async def execute(
        self,
        tool_name: str,
        args: dict[str, Any],
        context: WorkerToolContext,
        *,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        del timeout_seconds
        return self.registry.dispatch(tool_name, args, context)


class ProcessToolExecutor:
    """复用有界科学计算进程；超时或取消时只销毁对应执行槽。"""

    def __init__(
        self,
        registry: WorkerToolRegistry,
        *,
        pool_size: int = 1,
        options: ProcessExecutionOptions | None = None,
    ) -> None:
        if pool_size <= 0:
            raise ValueError("Worker 进程池大小必须大于 0")
        self.registry = registry
        self.pool_size = pool_size
        self.options = options or ProcessExecutionOptions()
        # Spawn 不继承 event loop、数据库连接或原生库锁；进程启动后循环消费
        # 任务，避免每个轻量工具都重复支付解释器与科学包导入成本。
        self._context = multiprocessing.get_context("spawn")
        self._available: asyncio.Queue[_ProcessSlot | None] | None = None
        self._state_lock: asyncio.Lock | None = None
        self._closed_event: asyncio.Event | None = None
        self._slots: set[_ProcessSlot] = set()
        self._active_slots: set[_ProcessSlot] = set()
        self._started = False
        self._closing = False
        self._shutdown_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        """预热固定数量的执行进程；同一实例只启动一次。"""

        if self._started:
            return
        if self._closing:
            raise RuntimeError("Worker 工具进程池已关闭")
        async with self._lock():
            if self._started:
                return
            if self._closing:
                raise WorkerToolExecutionError("Worker 工具进程池已关闭")
            tasks = [asyncio.create_task(self._spawn_slot()) for _ in range(self.pool_size)]
            try:
                results = await asyncio.gather(*tasks, return_exceptions=True)
            except BaseException:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                results = await asyncio.gather(*tasks, return_exceptions=True)
                slots = [item for item in results if isinstance(item, _ProcessSlot)]
                cleanup_errors = await self._stop_unpublished_slots(slots)
                if cleanup_errors:
                    raise WorkerToolExecutionError(
                        "Worker 工具进程池启动取消后未能完整回收"
                    ) from cleanup_errors[0]
                raise
            slots = [item for item in results if isinstance(item, _ProcessSlot)]
            errors = [item for item in results if isinstance(item, BaseException)]
            if errors or self._closing:
                cleanup_errors = await self._stop_unpublished_slots(slots)
                if cleanup_errors:
                    raise WorkerToolExecutionError(
                        "Worker 工具进程池启动失败后未能完整回收"
                    ) from cleanup_errors[0]
                if errors:
                    raise errors[0]
                raise WorkerToolExecutionError("Worker 工具进程池已关闭")
            queue = self._queue()
            for slot in slots:
                self._slots.add(slot)
                queue.put_nowait(slot)
            self._started = True

    async def _stop_unpublished_slots(
        self,
        slots: list[_ProcessSlot],
    ) -> list[BaseException]:
        for slot in slots:
            self._slots.add(slot)
        results = await asyncio.gather(
            *(asyncio.to_thread(self._stop_slot, slot, False) for slot in slots),
            return_exceptions=True,
        )
        for slot in slots:
            if slot.stopped:
                self._slots.discard(slot)
        errors = [result for result in results if isinstance(result, BaseException)]
        if errors:
            self._closing = True
            self._close_signal().set()
        return errors

    async def shutdown(self) -> None:
        """停止接收新任务，并回收空闲和运行中的所有执行进程。"""

        if self._shutdown_task is None or (
            self._shutdown_task.done()
            and (
                self._shutdown_task.cancelled()
                or self._shutdown_task.exception() is not None
            )
        ):
            self._closing = True
            self._close_signal().set()
            self._shutdown_task = asyncio.create_task(self._shutdown_slots())
        shutdown_task = self._shutdown_task
        try:
            await asyncio.shield(shutdown_task)
        except asyncio.CancelledError:
            # 调用方取消不等于允许遗留科学计算进程。共享清理继续执行，当前
            # shutdown 在资源全部释放后再把取消传播给上层。
            await shutdown_task
            raise

    async def _shutdown_slots(self) -> None:
        async with self._lock():
            slots = tuple(self._slots)
            active = set(self._active_slots)
            self._started = False
            queue = self._queue()
            while not queue.empty():
                queue.get_nowait()
        results = await asyncio.gather(
            *(
                asyncio.to_thread(self._stop_slot, slot, slot not in active)
                for slot in slots
            ),
            return_exceptions=True,
        )
        errors = [result for result in results if isinstance(result, BaseException)]
        async with self._lock():
            for slot in slots:
                if slot.stopped:
                    self._slots.discard(slot)
        if errors:
            raise WorkerToolExecutionError("Worker 工具进程池未能完整关闭") from errors[0]

    async def execute(
        self,
        tool_name: str,
        args: dict[str, Any],
        context: WorkerToolContext,
        *,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        if timeout_seconds <= 0:
            raise ValueError("Worker 工具超时必须大于 0")
        if self._closing:
            raise RuntimeError("Worker 工具进程池已关闭")

        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        try:
            remaining = _remaining_seconds(loop, deadline)
            await asyncio.wait_for(self.start(), timeout=remaining)
            remaining = _remaining_seconds(loop, deadline)
            slot = await asyncio.wait_for(
                self._acquire_slot(),
                timeout=remaining,
            )
        except TimeoutError as exc:
            raise WorkerToolTimeoutError("Worker 工具执行超时") from exc
        self._active_slots.add(slot)
        request_id = uuid4().hex
        reusable = False

        try:
            try:
                remaining = _remaining_seconds(loop, deadline)
                await asyncio.wait_for(
                    asyncio.to_thread(
                        slot.connection.send,
                        (
                            "run",
                            request_id,
                            tool_name,
                            args,
                            str(context.path_sandbox.runtime_root),
                        ),
                    ),
                    timeout=remaining,
                ),
            except TimeoutError as exc:
                raise WorkerToolTimeoutError("Worker 工具执行超时") from exc
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise WorkerToolTimeoutError("Worker 工具执行超时")
                ready = await asyncio.to_thread(
                    slot.connection.poll,
                    min(self.options.poll_interval_seconds, remaining),
                )
                if ready:
                    remaining = _remaining_seconds(loop, deadline)
                    try:
                        message = await asyncio.wait_for(
                            asyncio.to_thread(slot.connection.recv),
                            timeout=remaining,
                        )
                    except TimeoutError as exc:
                        raise WorkerToolTimeoutError("Worker 工具执行超时") from exc
                    decoded = _worker_response(message, request_id)
                    result = _decode_child_message(decoded)
                    reusable = True
                    return result
                if not slot.process.is_alive():
                    if slot.connection.poll():
                        remaining = _remaining_seconds(loop, deadline)
                        try:
                            message = await asyncio.wait_for(
                                asyncio.to_thread(slot.connection.recv),
                                timeout=remaining,
                            )
                        except TimeoutError as exc:
                            raise WorkerToolTimeoutError("Worker 工具执行超时") from exc
                        decoded = _worker_response(message, request_id)
                        result = _decode_child_message(decoded)
                        reusable = True
                        return result
                    raise WorkerToolExecutionError("Worker 工具子进程异常退出")
        except asyncio.CancelledError:
            raise
        except WorkerToolTimeoutError:
            raise
        except WorkerToolExecutionError as exc:
            reusable = exc.invalid_request
            raise
        except (BrokenPipeError, EOFError, OSError, ValueError) as exc:
            raise WorkerToolExecutionError("Worker 工具子进程连接已关闭") from exc
        finally:
            self._active_slots.discard(slot)
            if reusable and not self._closing and not slot.stopped and slot.process.is_alive():
                self._queue().put_nowait(slot)
            else:
                removed = slot in self._slots
                await asyncio.to_thread(self._stop_slot, slot, False)
                self._slots.discard(slot)
                if removed and not self._closing:
                    # 唤醒一个等待者，由它按当前容量补建执行槽。None 只表示
                    # 容量发生变化，不承载任务，也不会跨请求复用失败状态。
                    self._queue().put_nowait(None)

    async def _acquire_slot(self) -> _ProcessSlot:
        queue = self._queue()
        while True:
            if self._closing:
                raise WorkerToolExecutionError("Worker 工具进程池已关闭")
            while not queue.empty():
                available = queue.get_nowait()
                if available is not None:
                    return available
            async with self._lock():
                if self._closing:
                    raise WorkerToolExecutionError("Worker 工具进程池已关闭")
                while not queue.empty():
                    available = queue.get_nowait()
                    if available is not None:
                        return available
                if len(self._slots) < self.pool_size:
                    try:
                        slot = await self._spawn_slot()
                    except BaseException:
                        if not self._closing and len(self._slots) < self.pool_size:
                            # 当前等待者取得了“可补槽”通知却未能完成补建；
                            # 把容量通知交给下一等待者，避免整个队列失去唤醒源。
                            queue.put_nowait(None)
                        raise
                    if self._closing:
                        await asyncio.to_thread(self._stop_slot, slot, False)
                        raise WorkerToolExecutionError("Worker 工具进程池已关闭")
                    self._slots.add(slot)
                    return slot
            slot_task = asyncio.create_task(queue.get())
            close_task = asyncio.create_task(self._close_signal().wait())
            item_consumed = False
            try:
                done, _ = await asyncio.wait(
                    (slot_task, close_task),
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if close_task in done:
                    raise WorkerToolExecutionError("Worker 工具进程池已关闭")
                available = slot_task.result()
                item_consumed = True
                if available is not None:
                    return available
            finally:
                for task in (slot_task, close_task):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(slot_task, close_task, return_exceptions=True)
                if (
                    not item_consumed
                    and not self._closing
                    and slot_task.done()
                    and not slot_task.cancelled()
                    and slot_task.exception() is None
                ):
                    # acquire 自身被取消时，queue.get 可能恰好已取得可用槽；
                    # 必须放回，否则槽仍计入池容量却再也不会被调度。
                    queue.put_nowait(slot_task.result())

    async def _spawn_slot(self) -> _ProcessSlot:
        parent_connection, child_connection = self._context.Pipe(duplex=True)
        process = self._context.Process(
            target=_run_tool_worker,
            args=(child_connection, self.registry),
            name="geo-worker-tool-slot",
            daemon=True,
        )
        slot = _ProcessSlot(process=process, connection=parent_connection)
        try:
            process.start()
            child_connection.close()
            message = await asyncio.wait_for(
                asyncio.to_thread(parent_connection.recv),
                timeout=self.options.startup_timeout_seconds,
            )
            if not isinstance(message, tuple) or len(message) != 2 or message[0] != "ready":
                raise WorkerToolExecutionError("Worker 工具进程启动握手无效")
            return slot
        except BaseException:
            child_connection.close()
            try:
                await asyncio.to_thread(self._stop_slot, slot, False)
            except BaseException as cleanup_error:
                self._slots.add(slot)
                self._closing = True
                self._close_signal().set()
                raise WorkerToolExecutionError(
                    "Worker 工具进程启动失败后未能回收"
                ) from cleanup_error
            raise

    def _queue(self) -> asyncio.Queue[_ProcessSlot | None]:
        if self._available is None:
            self._available = asyncio.Queue()
        return self._available

    def _lock(self) -> asyncio.Lock:
        if self._state_lock is None:
            self._state_lock = asyncio.Lock()
        return self._state_lock

    def _close_signal(self) -> asyncio.Event:
        if self._closed_event is None:
            self._closed_event = asyncio.Event()
        return self._closed_event

    def _stop_slot(self, slot: _ProcessSlot, graceful: bool) -> None:
        with slot.stop_lock:
            if slot.stopped:
                return
            self._stop_slot_once(slot, graceful)
            slot.stopped = True

    def _stop_slot_once(self, slot: _ProcessSlot, graceful: bool) -> None:
        try:
            if graceful and slot.process.is_alive():
                try:
                    slot.connection.send(("shutdown",))
                    slot.process.join(timeout=self.options.terminate_grace_seconds)
                except (BrokenPipeError, EOFError, OSError):
                    pass
            self._stop_process(slot.process)
        finally:
            try:
                slot.connection.close()
            except OSError:
                pass

    def _stop_process(self, process: multiprocessing.Process) -> None:
        if process.pid is None:
            return
        if process.is_alive():
            process.terminate()
            process.join(timeout=self.options.terminate_grace_seconds)
        if process.is_alive() and hasattr(process, "kill"):
            process.kill()
            process.join(timeout=self.options.terminate_grace_seconds)
        else:
            process.join(timeout=0)
        process.close()


def _run_tool_worker(connection: Any, registry: WorkerToolRegistry) -> None:
    """常驻执行槽；一次只处理一个请求，并通过私有管道返回结构化结果。"""

    from worker_app.bootstrap import configure_science_package_path

    configure_science_package_path(Path(__file__))
    try:
        connection.send(("ready", multiprocessing.current_process().pid))
        while True:
            message = connection.recv()
            if message == ("shutdown",):
                return
            if not isinstance(message, tuple) or len(message) != 5 or message[0] != "run":
                raise RuntimeError("Worker 工具进程收到无效命令")
            _, request_id, tool_name, args, runtime_root = message
            try:
                context = WorkerToolContext(WorkerPathSandbox(Path(runtime_root)))
                payload = registry.dispatch(tool_name, args, context)
                connection.send((request_id, "ok", payload))
            except (ValueError, FileNotFoundError) as exc:
                connection.send((request_id, "invalid", str(exc)))
            except Exception as exc:  # pragma: no cover - native crashes have no Python traceback
                connection.send((
                    request_id,
                    "failed",
                    type(exc).__name__,
                    str(exc),
                    traceback.format_exc(limit=3),
                ))
    except EOFError:
        return
    finally:
        connection.close()


def _worker_response(message: Any, expected_request_id: str) -> tuple[Any, ...]:
    if not isinstance(message, tuple) or len(message) < 2:
        raise WorkerToolExecutionError("Worker 工具进程返回了无效消息")
    if message[0] != expected_request_id:
        raise WorkerToolExecutionError("Worker 工具进程响应与请求不匹配")
    if message[1] not in {"ok", "invalid", "failed"}:
        raise WorkerToolExecutionError("Worker 工具进程返回了未知消息")
    return tuple(message[1:])


def _remaining_seconds(loop: asyncio.AbstractEventLoop, deadline: float) -> float:
    remaining = deadline - loop.time()
    if remaining <= 0:
        raise WorkerToolTimeoutError("Worker 工具执行超时")
    return remaining


def _decode_child_message(message: Any) -> dict[str, Any]:
    if not isinstance(message, tuple) or not message:
        raise WorkerToolExecutionError("Worker 工具子进程返回了无效消息")
    kind = message[0]
    if kind == "ok" and len(message) == 2 and isinstance(message[1], dict):
        return message[1]
    if kind == "invalid" and len(message) == 2:
        raise WorkerToolExecutionError(str(message[1]), invalid_request=True)
    if kind == "failed" and len(message) >= 3:
        detail = str(message[2])
        raise WorkerToolExecutionError(f"Worker 工具子进程失败：{detail}")
    raise WorkerToolExecutionError("Worker 工具子进程返回了未知消息")

# +-------------------------------------------------------------------------
#   地理智能平台 - Worker 执行槽所有权交接回归测试
#   文件: test_worker_slot_handoff.py
#   日期: 2026年09月08日
#   AI 协助: OpenAI ChatGPT (GPT-6 Astra Pro)
# --------------------------------------------------------------------------

from __future__ import annotations

import asyncio
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "apps/worker/src"))
from worker_app.execution import ProcessToolExecutor, WorkerToolExecutionError
from worker_app.tool_registry import WorkerToolRegistry


class ControlledCloseSignal:
    """用事件固定取消窗口，不依赖时间碰撞或随机重试。"""

    def __init__(self):
        self.entered = asyncio.Event()
        self.cleaning = asyncio.Event()
        self.finish_cleanup = asyncio.Event()

    async def wait(self):
        self.entered.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            self.cleaning.set()
            await self.finish_cleanup.wait()
            raise


class SlotHandoffTests(unittest.IsolatedAsyncioTestCase):
    def pool(self):
        pool = ProcessToolExecutor(WorkerToolRegistry(), pool_size=1)
        # Only ownership is under test; the already registered slot is opaque.
        slot = object()
        pool._slots.add(slot)
        pool._started = True
        return pool, slot

    async def test_cancel_during_reader_cleanup_returns_slot(self):
        pool, slot = self.pool()
        close = ControlledCloseSignal()
        pool._closed_event = close
        task = asyncio.create_task(pool._acquire_slot())
        await asyncio.wait_for(close.entered.wait(), 0.5)
        pool._queue().put_nowait(slot)
        await asyncio.wait_for(close.cleaning.wait(), 0.5)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(pool._queue().qsize(), 1)
        self.assertIs(pool._queue().get_nowait(), slot)
        self.assertEqual(pool._slots, {slot})
        # Prove the next request can reuse capacity, not merely a queue count.
        pool._queue().put_nowait(slot)
        self.assertIs(await pool._acquire_slot(), slot)

    async def test_success_hands_off_only_after_reader_cleanup(self):
        pool, slot = self.pool()
        close = ControlledCloseSignal()
        pool._closed_event = close
        task = asyncio.create_task(pool._acquire_slot())
        await asyncio.wait_for(close.entered.wait(), 0.5)
        pool._queue().put_nowait(slot)
        await asyncio.wait_for(close.cleaning.wait(), 0.5)
        self.assertFalse(task.done())
        close.finish_cleanup.set()
        self.assertIs(await task, slot)
        self.assertEqual(pool._queue().qsize(), 0)

    async def test_cancellation_racing_queue_arrival_does_not_lose_or_duplicate_slot(self):
        pool, slot = self.pool()
        task = asyncio.create_task(pool._acquire_slot())
        # Enter the two-reader wait before arranging the competing signals.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        pool._queue().put_nowait(slot)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)
        self.assertEqual(pool._queue().qsize(), 1)
        self.assertIs(pool._queue().get_nowait(), slot)

    async def test_shutdown_wins_over_an_arriving_slot(self):
        pool, slot = self.pool()
        task = asyncio.create_task(pool._acquire_slot())
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        pool._closing = True
        pool._close_signal().set()
        pool._queue().put_nowait(slot)
        with self.assertRaises(WorkerToolExecutionError):
            await task
        # Shutdown owns registered slots even if a waiter consumed the queue.
        self.assertEqual(pool._slots, {slot})


if __name__ == "__main__":
    unittest.main()

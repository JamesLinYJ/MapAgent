# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 跨进程生命周期资源测试
#
#   文件:       test_worker_lifecycle.py
#
#   日期:       2026年08月03日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5
# --------------------------------------------------------------------------

"""验证跨应用实例的并发租约不会突破全局上限。"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_SRC = REPO_ROOT / "apps" / "worker" / "src"
if str(WORKER_SRC) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC))

from worker_app.lifecycle import SqliteConcurrencyLimiter


class WorkerLifecycleTests(unittest.TestCase):
    def test_sqlite_limiter_is_global_across_instances(self) -> None:
        async def scenario() -> tuple[float, bool]:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "concurrency.sqlite3"
                first = SqliteConcurrencyLimiter(path, 1, lease_ttl_seconds=5, poll_interval_seconds=0.01)
                second = SqliteConcurrencyLimiter(path, 1, lease_ttl_seconds=5, poll_interval_seconds=0.01)
                first_lease = await first.acquire()
                acquired_at: float | None = None

                async def wait_for_second() -> None:
                    nonlocal acquired_at
                    await second.acquire()
                    acquired_at = time.perf_counter()

                started = time.perf_counter()
                waiter = asyncio.create_task(wait_for_second())
                await asyncio.sleep(0.08)
                self.assertFalse(waiter.done(), "第二个 Worker 实例不应越过全局并发上限")
                await first.release(first_lease)
                await asyncio.wait_for(waiter, timeout=1)
                await second.release()
                return acquired_at or 0, started

        acquired_at, started = asyncio.run(scenario())
        self.assertGreater(acquired_at, started)


if __name__ == "__main__":
    unittest.main()

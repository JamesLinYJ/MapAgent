# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 跨进程生命周期资源
#
#   文件:       lifecycle.py
#
#   日期:       2026年08月03日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5
# --------------------------------------------------------------------------

"""Worker 跨进程 nonce 与并发租约。

Uvicorn 多 worker 进程不会共享 Python 内存，因此进程内 dict/semaphore
无法提供全局重放防护或全局并发上限。SQLite 在本机运行时目录中提供原子
事务：nonce 使用唯一键，执行槽位使用短期租约，进程崩溃后租约会自动过期。
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from dataclasses import dataclass
import os
from pathlib import Path
import sqlite3
import time
from uuid import uuid4


class LifecycleStoreError(RuntimeError):
    """生命周期共享存储不可用。"""


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=5.0)
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA journal_mode=WAL")
    return connection


@contextmanager
def _opened(path: Path):
    connection = _connect(path)
    try:
        yield connection
    finally:
        connection.close()


class SqliteNonceStore:
    """跨 Worker 进程共享的 nonce 一次性消费表。"""

    def __init__(self, path: Path) -> None:
        self.path = Path(path).resolve()
        try:
            with _opened(self.path) as connection:
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS worker_nonces ("
                    "nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL"
                    ")"
                )
                connection.execute(
                    "CREATE INDEX IF NOT EXISTS idx_worker_nonces_expires_at "
                    "ON worker_nonces(expires_at)"
                )
        except sqlite3.Error as exc:
            raise LifecycleStoreError(f"Worker nonce 存储初始化失败：{exc}") from exc

    def consume(self, nonce: str, expires_at: int, now: int, max_entries: int) -> bool:
        """原子地登记 nonce；已存在时返回 False。"""

        try:
            with _opened(self.path) as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute("DELETE FROM worker_nonces WHERE expires_at < ?", (now,))
                duplicate = connection.execute(
                    "SELECT 1 FROM worker_nonces WHERE nonce = ?", (nonce,)
                ).fetchone()
                if duplicate is not None:
                    connection.rollback()
                    return False
                count = int(connection.execute("SELECT COUNT(*) FROM worker_nonces").fetchone()[0])
                overflow = count - max(0, max_entries - 1)
                if overflow > 0:
                    connection.execute(
                        "DELETE FROM worker_nonces WHERE nonce IN ("
                        "SELECT nonce FROM worker_nonces ORDER BY expires_at ASC LIMIT ?"
                        ")",
                        (overflow,),
                    )
                connection.execute(
                    "INSERT INTO worker_nonces(nonce, expires_at) VALUES (?, ?)",
                    (nonce, expires_at),
                )
                connection.commit()
                return True
        except sqlite3.Error as exc:
            raise LifecycleStoreError(f"Worker nonce 存储写入失败：{exc}") from exc

    def purge_expired(self, now: int) -> None:
        try:
            with _opened(self.path) as connection:
                connection.execute("DELETE FROM worker_nonces WHERE expires_at < ?", (now,))
                connection.commit()
        except sqlite3.Error as exc:
            raise LifecycleStoreError(f"Worker nonce 存储清理失败：{exc}") from exc

    def size(self) -> int:
        try:
            with _opened(self.path) as connection:
                row = connection.execute("SELECT COUNT(*) FROM worker_nonces").fetchone()
                return int(row[0])
        except sqlite3.Error as exc:
            raise LifecycleStoreError(f"Worker nonce 存储读取失败：{exc}") from exc


@dataclass(frozen=True, slots=True)
class ConcurrencyLease:
    lease_id: str
    expires_at: float


class SqliteConcurrencyLimiter:
    """跨 Worker 进程共享的有界并发租约。"""

    def __init__(
        self,
        path: Path,
        max_concurrency: int,
        *,
        lease_ttl_seconds: float,
        poll_interval_seconds: float = 0.05,
    ) -> None:
        if max_concurrency <= 0:
            raise ValueError("Worker 全局并发上限必须大于 0")
        if lease_ttl_seconds <= 0:
            raise ValueError("Worker 并发租约 TTL 必须大于 0")
        self.path = Path(path).resolve()
        self.max_concurrency = max_concurrency
        self.lease_ttl_seconds = lease_ttl_seconds
        self.poll_interval_seconds = poll_interval_seconds
        self._lease: ConcurrencyLease | None = None
        try:
            with _opened(self.path) as connection:
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS worker_concurrency_leases ("
                    "lease_id TEXT PRIMARY KEY, expires_at REAL NOT NULL"
                    ")"
                )
                connection.execute(
                    "CREATE INDEX IF NOT EXISTS idx_worker_concurrency_expires_at "
                    "ON worker_concurrency_leases(expires_at)"
                )
        except sqlite3.Error as exc:
            raise LifecycleStoreError(f"Worker 并发存储初始化失败：{exc}") from exc

    async def acquire(self) -> ConcurrencyLease:
        """等待并取得一个全局执行槽；取消等待不会留下租约。"""

        while True:
            operation = asyncio.create_task(asyncio.to_thread(self._try_acquire))
            try:
                # Shield the short SQLite transaction so cancellation cannot
                # land after INSERT but before the caller receives the lease.
                lease = await asyncio.shield(operation)
            except asyncio.CancelledError:
                lease = await operation
                if lease is not None:
                    await asyncio.to_thread(self._release, lease.lease_id)
                raise
            if lease is not None:
                self._lease = lease
                return lease
            await asyncio.sleep(self.poll_interval_seconds)

    async def release(self, lease: ConcurrencyLease | None = None) -> None:
        current = lease or self._lease
        if current is None:
            return
        self._lease = None
        operation = asyncio.create_task(asyncio.to_thread(self._release, current.lease_id))
        try:
            await asyncio.shield(operation)
        except asyncio.CancelledError:
            await operation
            raise

    def _try_acquire(self) -> ConcurrencyLease | None:
        now = time.time()
        expires_at = now + self.lease_ttl_seconds
        lease_id = f"{os.getpid()}-{uuid4().hex}"
        try:
            with _opened(self.path) as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "DELETE FROM worker_concurrency_leases WHERE expires_at <= ?", (now,)
                )
                count = int(
                    connection.execute("SELECT COUNT(*) FROM worker_concurrency_leases").fetchone()[0]
                )
                if count >= self.max_concurrency:
                    connection.rollback()
                    return None
                connection.execute(
                    "INSERT INTO worker_concurrency_leases(lease_id, expires_at) VALUES (?, ?)",
                    (lease_id, expires_at),
                )
                connection.commit()
                return ConcurrencyLease(lease_id, expires_at)
        except sqlite3.Error as exc:
            raise LifecycleStoreError(f"Worker 并发租约申请失败：{exc}") from exc

    def _release(self, lease_id: str) -> None:
        try:
            with _opened(self.path) as connection:
                connection.execute(
                    "DELETE FROM worker_concurrency_leases WHERE lease_id = ?", (lease_id,)
                )
                connection.commit()
        except sqlite3.Error as exc:
            raise LifecycleStoreError(f"Worker 并发租约释放失败：{exc}") from exc

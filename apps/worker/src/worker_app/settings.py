# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 环境配置
#
#   文件:       settings.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""Worker 环境配置边界。"""

from __future__ import annotations

from dataclasses import dataclass
import math
import os
from pathlib import Path


@dataclass(frozen=True)
class WorkerSettings:
    runtime_root: Path
    shared_secret: str | None
    max_body_bytes: int
    max_concurrency: int
    clock_skew_seconds: int
    tool_timeout_seconds: float
    nonce_cache_max: int
    nonce_store_path: Path
    concurrency_store_path: Path
    concurrency_lease_seconds: float

    @classmethod
    def from_env(cls) -> "WorkerSettings":
        runtime_root = Path(os.environ.get("RUNTIME_ROOT", "runtime")).resolve()
        tool_timeout_seconds = _positive_float("WORKER_TOOL_TIMEOUT_SECONDS", 300.0)
        concurrency_lease_seconds = _positive_float(
            "WORKER_CONCURRENCY_LEASE_SECONDS",
            tool_timeout_seconds + 30.0,
        )
        if concurrency_lease_seconds < tool_timeout_seconds:
            raise ValueError("WORKER_CONCURRENCY_LEASE_SECONDS 不能小于 WORKER_TOOL_TIMEOUT_SECONDS")
        return cls(
            runtime_root=runtime_root,
            shared_secret=os.environ.get("WORKER_SHARED_SECRET"),
            max_body_bytes=_positive_int("WORKER_MAX_BODY_BYTES", 16 * 1024 * 1024),
            max_concurrency=_positive_int("WORKER_MAX_CONCURRENCY", 2),
            clock_skew_seconds=_non_negative_int("WORKER_CLOCK_SKEW_SECONDS", 30),
            tool_timeout_seconds=tool_timeout_seconds,
            nonce_cache_max=_positive_int("WORKER_NONCE_CACHE_MAX", 10_000),
            nonce_store_path=Path(
                os.environ.get("WORKER_NONCE_STORE_PATH", str(runtime_root / ".worker-nonces.sqlite3"))
            ).resolve(),
            concurrency_store_path=Path(
                os.environ.get("WORKER_CONCURRENCY_STORE_PATH", str(runtime_root / ".worker-concurrency.sqlite3"))
            ).resolve(),
            concurrency_lease_seconds=concurrency_lease_seconds,
        )


def _positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} 必须是整数") from exc
    if value <= 0:
        raise ValueError(f"{name} 必须大于 0")
    return value


def _non_negative_int(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} 必须是整数") from exc
    if value < 0:
        raise ValueError(f"{name} 不能小于 0")
    return value


def _positive_float(name: str, default: float) -> float:
    raw = os.environ.get(name, str(default))
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} 必须是数字") from exc
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} 必须大于 0")
    return value

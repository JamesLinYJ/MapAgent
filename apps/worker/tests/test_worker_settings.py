# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 配置边界测试
# --------------------------------------------------------------------------

from __future__ import annotations

import os
from pathlib import Path

import pytest

from worker_app.settings import WorkerSettings


def test_invalid_numeric_settings_fail_with_named_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_MAX_CONCURRENCY", "not-a-number")

    with pytest.raises(ValueError, match="WORKER_MAX_CONCURRENCY"):
        WorkerSettings.from_env()


def test_non_finite_timeout_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_TOOL_TIMEOUT_SECONDS", "nan")

    with pytest.raises(ValueError, match="WORKER_TOOL_TIMEOUT_SECONDS"):
        WorkerSettings.from_env()


def test_valid_settings_are_parsed_without_algorithm_dependencies(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("RUNTIME_ROOT", str(tmp_path))
    monkeypatch.setenv("WORKER_MAX_CONCURRENCY", "3")
    monkeypatch.setenv("WORKER_TOOL_TIMEOUT_SECONDS", "12.5")
    monkeypatch.setenv("WORKER_CONCURRENCY_LEASE_SECONDS", "20")

    settings = WorkerSettings.from_env()

    assert settings.runtime_root == tmp_path.resolve()
    assert settings.max_concurrency == 3
    assert settings.tool_timeout_seconds == 12.5
    assert settings.concurrency_lease_seconds == 20.0
    assert os.fspath(settings.nonce_store_path).startswith(os.fspath(tmp_path.resolve()))

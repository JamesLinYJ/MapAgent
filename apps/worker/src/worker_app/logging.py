# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 结构化日志
#
#   文件:       logging.py
#
#   日期:       2026年07月08日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

"""Worker 统一日志边界。"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import logging
import os
import re
from typing import Any


class WorkerJsonFormatter(logging.Formatter):
    """输出结构化 JSON 日志，并在格式化阶段统一清理本地路径。"""

    _standard_keys = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__.keys())
    _allowed_fields = {
        "category",
        "content_length",
        "duration_ms",
        "event",
        "failure_code",
        "limit",
        "request_id",
        "retention",
        "run_id",
        "status",
        "thread_id",
        "tool_name",
        "trace_id",
    }

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "service": "geo-agent-platform-worker",
            "logger": record.name,
            "message": sanitize_log_text(record.getMessage()),
            "event": getattr(record, "event", "worker.output"),
            "category": getattr(record, "category", "system"),
            "retention": getattr(
                record,
                "retention",
                "diagnostic" if record.levelno <= logging.DEBUG else "operational",
            ),
        }
        for key, value in record.__dict__.items():
            if key in self._standard_keys or key.startswith("_") or key not in self._allowed_fields:
                continue
            if should_redact_key(key):
                payload[key] = "[REDACTED]"
                continue
            if isinstance(value, (str, int, float, bool)) or value is None:
                payload[key] = sanitize_log_text(value) if isinstance(value, str) else value
        if record.exc_info:
            error_type = record.exc_info[0]
            error_value = record.exc_info[1]
            payload["error"] = {
                "name": error_type.__name__ if error_type else "Exception",
                "message": sanitize_log_text(str(error_value)) if error_value else "Worker 工具执行失败",
                "stack": sanitize_log_text(self.formatException(record.exc_info)),
            }
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def configure_logging() -> None:
    level_name = os.environ.get("WORKER_LOG_LEVEL", "INFO").upper()
    handler = logging.StreamHandler()
    handler.setFormatter(WorkerJsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.WARNING)
    logging.getLogger("worker").setLevel(getattr(logging, level_name, logging.INFO))
    logging.getLogger("uvicorn.error").setLevel(logging.INFO)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    for logger_name in ("asyncio", "fiona", "matplotlib", "numba", "rasterio"):
        logging.getLogger(logger_name).setLevel(logging.WARNING)


def sanitize_log_text(value: str) -> str:
    value = re.sub(r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", value, flags=re.IGNORECASE)
    value = re.sub(r"\bsk-[A-Za-z0-9_-]{10,}\b", "[REDACTED]", value)
    value = re.sub(
        r"([?&](?:api[_-]?key|key|token|access[_-]?token|authorization|password|secret)=)[^&#\s'\"<>),]+",
        r"\1[REDACTED]",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"file:///?[^\s'\"<>),]+", "[LOCAL_PATH]", value)
    value = re.sub(r"(^|[^A-Za-z])[A-Za-z]:[\\/][^\s'\"<>),]+", r"\1[LOCAL_PATH]", value)
    return re.sub(r"(^|[\s(\"'=])/(?:Users|home|var|tmp|opt|mnt|srv|workspace|app)/[^\s'\"<>),]+", r"\1[LOCAL_PATH]", value)


def should_redact_key(key: str) -> bool:
    normalized = key.lower()
    return (
        "authorization" in normalized
        or "cookie" in normalized
        or "csrf" in normalized
        or "password" in normalized
        or "secret" in normalized
        or normalized.endswith("token")
        or normalized.endswith("apikey")
        or normalized == "apikey"
    )

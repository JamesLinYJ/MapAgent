# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 请求参数解析
#
#   文件:       request_args.py
#
#   日期:       2026年07月08日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

"""Worker 工具参数的最小解析边界。"""

from __future__ import annotations

from typing import Any


def required_text(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} 不能为空")
    return value.strip()


def optional_text(args: dict[str, Any], key: str) -> str | None:
    value = args.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def optional_int(args: dict[str, Any], key: str) -> int | None:
    value = args.get(key)
    return int(value) if value is not None else None


def required_float(args: dict[str, Any], key: str) -> float:
    value = args.get(key)
    if value is None:
        raise ValueError(f"{key} 不能为空")
    return float(value)


def optional_float(args: dict[str, Any], key: str) -> float | None:
    value = args.get(key)
    return float(value) if value is not None else None


def optional_dict(args: dict[str, Any], key: str) -> dict[str, Any] | None:
    value = args.get(key)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"{key} 必须是对象")
    return value


def optional_list_of_dicts(args: dict[str, Any], key: str) -> list[dict[str, Any]] | None:
    value = args.get(key)
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValueError(f"{key} 必须是数组")
    if not all(isinstance(item, dict) for item in value):
        raise ValueError(f"{key} 中每一项必须是对象")
    return value


def optional_number_list(args: dict[str, Any], key: str) -> list[float] | None:
    value = args.get(key)
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValueError(f"{key} 必须是数组")
    return [float(item) for item in value]

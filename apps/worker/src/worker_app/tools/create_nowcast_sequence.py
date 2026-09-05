# +-------------------------------------------------------------------------
#
#   地理智能平台 - 短临文件序列创建工具
#
#   文件:       create_nowcast_sequence.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""短临文件序列创建工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.nowcast_bridge import create_nowcast_sequence, serialize_nowcast_sequence
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
    sandbox = context.path_sandbox
    return serialize_nowcast_sequence(create_nowcast_sequence(args, sandbox), sandbox)


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "create_nowcast_sequence",
        execute,
        request_model=contracts.CreateNowcastSequenceRequest,
        value_ref_outputs=("nowcast_sequence",),
    )

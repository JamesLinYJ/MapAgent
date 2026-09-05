# +-------------------------------------------------------------------------
#
#   地理智能平台 - 短临文件序列检查工具
#
#   文件:       inspect_nowcast_sequence.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""短临文件序列检查工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.nowcast_bridge import nowcast_sequence_from_reference
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology import NowcastSequenceService

    sequence = nowcast_sequence_from_reference(args, context.path_sandbox)
    return NowcastSequenceService().inspect_sequence(sequence)


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "inspect_nowcast_sequence",
        execute,
        request_model=contracts.InspectNowcastSequenceRequest,
        value_ref_outputs=("nowcast_sequence_inspection",),
    )

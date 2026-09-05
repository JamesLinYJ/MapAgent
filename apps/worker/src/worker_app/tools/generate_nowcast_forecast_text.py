# +-------------------------------------------------------------------------
#
#   地理智能平台 - 短临预报文本生成工具
#
#   文件:       generate_nowcast_forecast_text.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""正式短临文本草稿工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], _context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology import NowcastTextService

    analysis = args.get("analysis")
    if not isinstance(analysis, dict):
        raise ValueError("analysis 必须是对象")
    return NowcastTextService().build_draft_answer(
        facts=analysis,
        question="生成正式短时临近预报（短临）预报文字",
    )


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "generate_nowcast_forecast_text",
        execute,
        request_model=contracts.GenerateNowcastForecastTextRequest,
        value_ref_outputs=("nowcast_forecast_text",),
    )

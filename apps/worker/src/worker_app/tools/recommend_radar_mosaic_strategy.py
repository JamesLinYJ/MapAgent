# +-------------------------------------------------------------------------
#
#   地理智能平台 - 雷达组网策略推荐工具
#
#   文件:       recommend_radar_mosaic_strategy.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""雷达组网策略推荐工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.request_args import optional_text
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], _context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology.third_party.radar_mosaic_agent.adapter import recommend_radar_mosaic_strategy

    return recommend_radar_mosaic_strategy(
        goal_mode=optional_text(args, "goal_mode") or "quicklook",
        time_strategy=optional_text(args, "time_strategy") or "nearest",
    )


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "recommend_radar_mosaic_strategy",
        execute,
        request_model=contracts.RecommendRadarMosaicStrategyRequest,
        value_ref_outputs=("radar_mosaic_strategy",),
    )

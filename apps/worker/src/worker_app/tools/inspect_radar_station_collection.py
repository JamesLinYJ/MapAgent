# +-------------------------------------------------------------------------
#
#   地理智能平台 - 雷达站文件集合检查工具
#
#   文件:       inspect_radar_station_collection.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""雷达站文件集合检查工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_io import radar_semantic_input_paths
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology.third_party.radar_mosaic_agent.adapter import inspect_radar_station_collection

    with radar_semantic_input_paths(args, context, "files") as paths:
        return inspect_radar_station_collection(paths)


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "inspect_radar_station_collection",
        execute,
        request_model=contracts.RadarStationCollectionRequest,
        value_ref_outputs=("radar_station_collection", "radar_target_time"),
    )

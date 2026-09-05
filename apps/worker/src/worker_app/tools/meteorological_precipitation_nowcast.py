# +-------------------------------------------------------------------------
#
#   地理智能平台 - 降水短临分析工具
#
#   文件:       meteorological_precipitation_nowcast.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""降水短临确定性分析工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.nowcast_bridge import nowcast_sequence_from_reference
from worker_app.request_args import optional_dict, optional_float, optional_number_list, optional_text
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_io import relative_runtime_path
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology import NowcastAnalysisService

    sequence = nowcast_sequence_from_reference(
        args,
        context.path_sandbox,
        variable_override=optional_text(args, "variable"),
    )
    analysis = NowcastAnalysisService().analyze(
        sequence,
        area=optional_dict(args, "area"),
        bbox=optional_number_list(args, "bbox"),
        coordinate=optional_dict(args, "coordinate"),
        point_buffer_meters=optional_float(args, "point_buffer_meters") or 1000,
        district_name_field=optional_text(args, "district_name_field"),
    )
    relative_paths = {
        item.dataset_id: relative_runtime_path(item.path, context)
        for item in sequence.datasets
    }
    analysis["mapCandidates"] = [
        {**candidate, "relativePath": relative_paths.get(str(candidate.get("datasetId") or ""))}
        for candidate in analysis.get("mapCandidates", [])
    ]
    return analysis


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "meteorological_precipitation_nowcast",
        execute,
        request_model=contracts.MeteorologicalPrecipitationNowcastRequest,
        value_ref_outputs=("nowcast_analysis", "nowcast_map_candidate"),
    )

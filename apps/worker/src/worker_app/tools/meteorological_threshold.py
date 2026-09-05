# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象阈值区域提取工具
#
#   文件:       meteorological_threshold.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""气象阈值区域提取工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.request_args import optional_int, optional_number_list, optional_text, required_float
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_io import input_filename, input_path
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology.service import MeteorologicalDataService

    return MeteorologicalDataService().threshold_geojson(
        input_path(args, context),
        threshold=required_float(args, "threshold"),
        operator=optional_text(args, "operator") or ">=",
        filename=input_filename(args),
        variable=optional_text(args, "variable"),
        time_index=optional_int(args, "time_index"),
        level_index=optional_int(args, "level_index"),
        bbox=optional_number_list(args, "bbox"),
    )


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "meteorological_threshold",
        execute,
        request_model=contracts.MeteorologicalThresholdRequest,
        display_surfaces=("map", "download"),
        value_ref_outputs=("meteorological_threshold_result",),
    )

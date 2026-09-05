# +-------------------------------------------------------------------------
#
#   地理智能平台 - 降水风险区划图渲染工具
#
#   文件:       render_rainfall_risk_map.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""降水风险区划图渲染工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.request_args import optional_list_of_dicts, optional_text, required_text
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_io import input_path, optional_referenced_path, output_path, relative_runtime_path
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology.third_party.rainfall_risk_map.adapter import render_rainfall_risk_map

    output = output_path(args, context)
    output_geojson = (
        output_path(args, context, key="output_geojson_relative_path")
        if optional_text(args, "output_geojson_relative_path")
        else None
    )
    result = render_rainfall_risk_map(
        nc_path=input_path(args, context),
        output_png=output,
        output_geojson=output_geojson,
        variable=required_text(args, "variable"),
        boundary_path=optional_referenced_path(args, context, "boundary_relative_path"),
        thresholds=optional_list_of_dicts(args, "thresholds"),
        map_mode=optional_text(args, "map_mode") or "regional",
        aggregation=optional_text(args, "aggregation") or "mean",
        label_field=optional_text(args, "label_field"),
        title=optional_text(args, "title"),
    )
    result_with_paths = {**result, "outputRelativePath": relative_runtime_path(output, context)}
    if output_geojson is not None:
        result_with_paths["outputGeojsonRelativePath"] = relative_runtime_path(output_geojson, context)
    return result_with_paths


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "render_rainfall_risk_map",
        execute,
        request_model=contracts.RenderRainfallRiskMapRequest,
        display_surfaces=("map", "mini_app", "download"),
        value_ref_outputs=("rainfall_risk_map_result",),
    )

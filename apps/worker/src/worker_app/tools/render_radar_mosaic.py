# +-------------------------------------------------------------------------
#
#   地理智能平台 - 雷达组网拼接渲染工具
#
#   文件:       render_radar_mosaic.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""雷达组网拼接渲染工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.request_args import optional_float, optional_int, optional_text, required_text
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_io import output_path, radar_semantic_input_paths, relative_runtime_path
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology.third_party.radar_mosaic_agent.adapter import render_radar_mosaic

    output_png = output_path(args, context, key="output_png_relative_path")
    output_npz = output_path(args, context, key="output_npz_relative_path")
    output_map_png = (
        output_path(args, context, key="output_map_png_relative_path")
        if optional_text(args, "output_map_png_relative_path")
        else None
    )
    with radar_semantic_input_paths(args, context, "files") as paths:
        result = render_radar_mosaic(
            paths=paths,
            output_png=output_png,
            output_npz=output_npz,
            output_map_png=output_map_png,
            target_time=required_text(args, "target_time"),
            tolerance_sec=optional_int(args, "tolerance_sec") or 300,
            strategy=optional_text(args, "strategy") or "max",
            product=optional_text(args, "product") or "reflectivity",
            level_index=optional_int(args, "level_index") or 0,
            grid_res_km=optional_float(args, "grid_res_km") or 1.0,
            min_dbz=optional_float(args, "min_dbz") or 5.0,
        )
    output: dict[str, Any] = {
        **result,
        "outputPngRelativePath": relative_runtime_path(output_png, context),
        "outputNpzRelativePath": relative_runtime_path(output_npz, context),
    }
    if output_map_png is not None:
        output["outputMapPngRelativePath"] = relative_runtime_path(output_map_png, context)
    return output


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "render_radar_mosaic",
        execute,
        request_model=contracts.RenderRadarMosaicRequest,
        display_surfaces=("map", "mini_app", "download"),
        value_ref_outputs=("radar_mosaic_result",),
    )

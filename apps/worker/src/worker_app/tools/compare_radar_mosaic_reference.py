# +-------------------------------------------------------------------------
#
#   地理智能平台 - 雷达组网参考图对比工具
#
#   文件:       compare_radar_mosaic_reference.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""雷达组网结果参考图对比工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.request_args import optional_float, optional_int, optional_text, required_text
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_io import output_path, referenced_path, referenced_paths, relative_runtime_path
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology.third_party.radar_mosaic_agent.adapter import compare_radar_mosaic_reference

    output_png = output_path(args, context, key="output_png_relative_path")
    output_reference_png = output_path(args, context, key="output_reference_png_relative_path")
    result = compare_radar_mosaic_reference(
        mosaic_npz=referenced_path(
            {"relativePath": required_text(args, "mosaic_npz_relative_path")},
            context,
        ),
        reference_paths=referenced_paths(args, context, "reference_files"),
        output_png=output_png,
        output_reference_png=output_reference_png,
        target_time=required_text(args, "target_time"),
        level_index=optional_int(args, "level_index") or 0,
        product_label=optional_text(args, "product_label") or "反射率",
        product_unit=optional_text(args, "product_unit") or "dBZ",
        min_display=optional_float(args, "min_display") or 10.0,
    )
    return {
        **result,
        "outputPngRelativePath": relative_runtime_path(output_png, context),
        "outputReferencePngRelativePath": relative_runtime_path(output_reference_png, context),
    }


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "compare_radar_mosaic_reference",
        execute,
        request_model=contracts.CompareRadarMosaicReferenceRequest,
        display_surfaces=("mini_app", "download"),
        value_ref_outputs=("radar_reference_comparison",),
    )

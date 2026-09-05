# +-------------------------------------------------------------------------
#
#   地理智能平台 - 区域降水量表格生成工具
#
#   文件:       generate_area_rainfall_table.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""区域降水量表格生成工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.request_args import optional_dict, optional_int, optional_text, required_text
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_io import output_path, referenced_path, relative_runtime_path, sequence_sources
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology.third_party.short_term_forecast.adapter import generate_area_rainfall_table

    nc_paths, nc_names = sequence_sources(args, context)
    output_xlsx = output_path(args, context, key="output_xlsx_relative_path")
    output_png = output_path(args, context, key="output_png_relative_path")
    result = generate_area_rainfall_table(
        nc_paths=nc_paths,
        nc_names=nc_names,
        boundary_path=referenced_path(
            {"relativePath": required_text(args, "boundary_relative_path")},
            context,
        ),
        output_xlsx=output_xlsx,
        output_png=output_png,
        top_n=optional_int(args, "top_n") or 10,
        label_field=optional_text(args, "label_field"),
        style=optional_dict(args, "style"),
    )
    return {
        **result,
        "outputXlsxRelativePath": relative_runtime_path(output_xlsx, context),
        "outputPngRelativePath": relative_runtime_path(output_png, context),
    }


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "generate_area_rainfall_table",
        execute,
        request_model=contracts.GenerateAreaRainfallTableRequest,
        display_surfaces=("mini_app", "download"),
        value_ref_outputs=("area_rainfall_table_result",),
    )

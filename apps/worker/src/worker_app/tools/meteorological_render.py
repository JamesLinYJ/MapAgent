# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象栅格渲染工具
#
#   文件:       meteorological_render.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""气象栅格渲染工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.request_args import optional_int, optional_number_list, optional_text
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_io import input_filename, input_path, output_path, relative_runtime_path
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology.service import MeteorologicalDataService

    source = input_path(args, context)
    output = output_path(args, context)
    cog_output = output_path(args, context, key="output_cog_relative_path")
    result = MeteorologicalDataService().render_heatmap(
        source,
        output_path=output,
        cog_output_path=cog_output,
        filename=input_filename(args, source),
        variable=optional_text(args, "variable"),
        time_index=optional_int(args, "time_index"),
        level_index=optional_int(args, "level_index"),
        bbox=optional_number_list(args, "bbox"),
    )
    return {
        **result,
        "outputRelativePath": relative_runtime_path(output, context),
        "outputCogRelativePath": relative_runtime_path(cog_output, context),
    }


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "meteorological_render",
        execute,
        request_model=contracts.MeteorologicalRenderRequest,
        display_surfaces=("map", "download"),
        value_ref_outputs=("meteorological_render_result",),
    )

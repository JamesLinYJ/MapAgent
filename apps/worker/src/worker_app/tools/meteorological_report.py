# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象分析报告生成工具
#
#   文件:       meteorological_report.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""气象分析报告生成工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.request_args import required_text
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_io import input_filename, input_path, output_path, relative_runtime_path
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology.service import MeteorologicalDataService

    source = input_path(args, context)
    output = output_path(args, context)
    result = MeteorologicalDataService().generate_report_docx(
        source,
        output_path=output,
        filename=input_filename(args, source),
        llm_interpretation=required_text(args, "interpretation_text"),
    )
    return {**result, "outputRelativePath": relative_runtime_path(output, context)}


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "meteorological_report",
        execute,
        request_model=contracts.MeteorologicalReportRequest,
        read_only=False,
        display_surfaces=("download",),
    )

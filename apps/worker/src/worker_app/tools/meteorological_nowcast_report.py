# +-------------------------------------------------------------------------
#
#   地理智能平台 - 短临自动化运行报告工具
#
#   文件:       meteorological_nowcast_report.py
#
#   日期:       2026年07月18日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""从已校验的自动化运行事实生成确定性 DOCX 报告。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_io import output_path, relative_runtime_path
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology.report import write_nowcast_automation_report_docx

    output = output_path(args, context)
    result = write_nowcast_automation_report_docx(
        output_path=output,
        automation_run_id=str(args["automation_run_id"]),
        automation_id=str(args["automation_id"]),
        automation_revision=int(args["automation_revision"]),
        started_at=str(args["started_at"]),
        completed_at=str(args["completed_at"]),
        answer=str(args["answer"]),
        analysis=dict(args["analysis"]),
        artifacts=list(args["artifacts"]),
    )
    return {**result, "outputRelativePath": relative_runtime_path(output, context)}


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "meteorological_nowcast_report",
        execute,
        request_model=contracts.MeteorologicalNowcastReportRequest,
        read_only=False,
        display_surfaces=("download",),
    )

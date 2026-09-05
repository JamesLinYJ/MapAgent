# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象数据元数据检查工具
#
#   文件:       meteorological_inspect.py
#
#   日期:       2026年07月07日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

"""气象数据元数据检查工具。"""

from __future__ import annotations

from typing import Any

from worker_app import tool_contracts as contracts
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_io import input_filename, input_path
from worker_app.tool_registry import WorkerToolRegistry


def execute(args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
    from gis_meteorology.service import MeteorologicalDataService

    source = input_path(args, context)
    return MeteorologicalDataService().inspect(source, filename=input_filename(args, source))


def register(registry: WorkerToolRegistry) -> None:
    registry.register(
        "meteorological_inspect",
        execute,
        request_model=contracts.MeteorologicalInspectRequest,
        value_ref_outputs=("meteorological_dataset", "meteorological_variable"),
    )

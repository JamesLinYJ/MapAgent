# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 内置工具注册入口
#
#   文件:       __init__.py
#
#   日期:       2026年07月07日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

"""平台 内置科学计算工具注册入口。"""

from __future__ import annotations

from collections.abc import Callable

from worker_app.tool_registry import WorkerToolRegistry
from worker_app.tools import (
    answer_nowcast_question,
    compare_radar_mosaic_reference,
    create_nowcast_sequence,
    generate_area_rainfall_table,
    generate_nowcast_forecast_text,
    inspect_nowcast_sequence,
    inspect_radar_station_collection,
    meteorological_contour,
    meteorological_inspect,
    meteorological_precipitation_nowcast,
    meteorological_render,
    meteorological_report,
    meteorological_nowcast_report,
    meteorological_stats,
    meteorological_threshold,
    recommend_radar_mosaic_strategy,
    render_nowcast_raster,
    render_radar_mosaic,
    render_rainfall_risk_map,
)


ToolRegistrar = Callable[[WorkerToolRegistry], None]

_BUILTIN_TOOL_REGISTRARS: tuple[ToolRegistrar, ...] = (
    meteorological_inspect.register,
    meteorological_render.register,
    render_nowcast_raster.register,
    meteorological_stats.register,
    meteorological_threshold.register,
    meteorological_contour.register,
    meteorological_report.register,
    meteorological_nowcast_report.register,
    create_nowcast_sequence.register,
    inspect_nowcast_sequence.register,
    meteorological_precipitation_nowcast.register,
    answer_nowcast_question.register,
    generate_nowcast_forecast_text.register,
    inspect_radar_station_collection.register,
    recommend_radar_mosaic_strategy.register,
    render_radar_mosaic.register,
    compare_radar_mosaic_reference.register,
    render_rainfall_risk_map.register,
    generate_area_rainfall_table.register,
)


def register_builtin_tools(registry: WorkerToolRegistry) -> None:
    """将静态工具集合注册到指定的隔离 registry。"""

    for register in _BUILTIN_TOOL_REGISTRARS:
        register(registry)

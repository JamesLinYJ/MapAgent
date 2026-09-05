# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 系统路由
#
#   文件:       routes.py
#
#   日期:       2026年07月08日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

"""Worker 健康检查和工具目录路由。"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from worker_app.tool_registry import WorkerToolRegistry
from worker_app.worker_auth import WorkerAuthVerifier


def register_system_routes(
    app: FastAPI,
    *,
    worker_shared_secret: str | None,
    worker_auth: WorkerAuthVerifier,
    nonce_cache_max: int,
    tool_registry: WorkerToolRegistry,
) -> None:
    @app.get("/tools/catalog")
    async def tools_catalog() -> dict[str, Any]:
        return tool_registry.catalog()

    @app.get("/health")
    async def health():
        if not worker_shared_secret:
            return JSONResponse(
                {"status": "degraded", "live": True, "ready": False, "detail": "WORKER_SHARED_SECRET 未配置"},
                status_code=503,
            )
        try:
            import gis_meteorology  # noqa: F401
            import geopandas  # noqa: F401
            import matplotlib  # noqa: F401
            import numpy  # noqa: F401
            import openpyxl  # noqa: F401
            import pandas  # noqa: F401
            import scipy  # noqa: F401
        except ImportError as exc:
            raise HTTPException(503, f"gis_meteorology 不可用：{exc}") from exc
        return {
            "status": "ok",
            "live": True,
            "ready": True,
            "runtimeRootConfigured": True,
            "gisMeteorologyAvailable": True,
            "nonceCacheSize": worker_auth.nonce_cache_size,
            "nonceCacheMax": nonce_cache_max,
        }

    @app.get("/health/live")
    async def health_live() -> dict[str, bool | str]:
        return {"status": "ok", "live": True}

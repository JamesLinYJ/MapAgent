# +-------------------------------------------------------------------------
#
#   地理智能平台 - Python Worker 应用装配
#
#   文件:       app_factory.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""Python 科学计算 Worker 应用装配。"""

from __future__ import annotations

from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI

from worker_app.path_sandbox import WorkerPathSandbox
from worker_app.execution import ProcessToolExecutor
from worker_app.lifecycle import SqliteConcurrencyLimiter
from worker_app.routes import register_system_routes
from worker_app.security_middleware import WorkerSecurityMiddleware
from worker_app.settings import WorkerSettings
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry
from worker_app.tool_routes import register_tool_routes
from worker_app.tools import register_builtin_tools
from worker_app.worker_auth import WorkerAuthConfig, WorkerAuthVerifier


def create_worker_app(
    settings: WorkerSettings,
    *,
    logger: logging.Logger | None = None,
) -> FastAPI:
    """创建依赖隔离的 Worker 应用实例。"""

    app_logger = logger or logging.getLogger("worker")
    tool_registry = WorkerToolRegistry()
    register_builtin_tools(tool_registry)
    tool_context = WorkerToolContext(WorkerPathSandbox(settings.runtime_root))
    worker_auth = WorkerAuthVerifier(WorkerAuthConfig(
        shared_secret=settings.shared_secret,
        clock_skew_seconds=settings.clock_skew_seconds,
        nonce_cache_max=settings.nonce_cache_max,
        nonce_store_path=settings.nonce_store_path,
    ))
    concurrency_limiter = SqliteConcurrencyLimiter(
        settings.concurrency_store_path,
        settings.max_concurrency,
        lease_ttl_seconds=settings.concurrency_lease_seconds,
    )
    tool_executor = ProcessToolExecutor(tool_registry, pool_size=settings.max_concurrency)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        try:
            await tool_executor.start()
        except BaseException:
            try:
                await tool_executor.shutdown()
            except BaseException:
                app_logger.exception("Worker 工具进程池启动失败后的回收也失败")
            raise
        try:
            yield
        finally:
            await tool_executor.shutdown()

    app = FastAPI(title="geo-agent-platform-science-worker", version="0.3.0", lifespan=lifespan)
    app.add_middleware(
        WorkerSecurityMiddleware,
        worker_auth=worker_auth,
        max_body_bytes=settings.max_body_bytes,
        concurrency_limiter=concurrency_limiter,
        logger=app_logger,
    )
    register_system_routes(
        app,
        worker_shared_secret=settings.shared_secret,
        worker_auth=worker_auth,
        nonce_cache_max=settings.nonce_cache_max,
        tool_registry=tool_registry,
    )
    register_tool_routes(
        app,
        tool_timeout_seconds=settings.tool_timeout_seconds,
        logger=app_logger,
        tool_context=tool_context,
        tool_executor=tool_executor,
    )
    app.state.tool_registry = tool_registry
    app.state.tool_context = tool_context
    app.state.tool_executor = tool_executor
    return app

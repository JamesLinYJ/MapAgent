# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 工具执行上下文
#
#   文件:       tool_context.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""Worker 工具执行上下文。"""

from __future__ import annotations

from dataclasses import dataclass

from worker_app.path_sandbox import WorkerPathSandbox


@dataclass(frozen=True)
class WorkerToolContext:
    """由应用装配层注入工具的运行时依赖。"""

    path_sandbox: WorkerPathSandbox

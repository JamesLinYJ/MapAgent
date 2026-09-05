# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 契约清单命令
#
#   只装配 registry 并输出 JSON，不启动 HTTP 服务，也不执行科学算法。
# --------------------------------------------------------------------------

"""输出 Worker 的真实工具 catalog，供发布和架构清单生成使用。"""

from __future__ import annotations

import json

from worker_app.tool_registry import WorkerToolRegistry
from worker_app.tools import register_builtin_tools


def main() -> None:
    registry = WorkerToolRegistry()
    register_builtin_tools(registry)
    print(json.dumps(registry.catalog(), ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()

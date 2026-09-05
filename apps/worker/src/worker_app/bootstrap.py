# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 启动路径配置
#
#   文件:       bootstrap.py
#
#   日期:       2026年07月08日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

"""Worker 本地开发和生产环境的科学计算包导入路径配置。"""

from __future__ import annotations

import os
from pathlib import Path
import sys


def configure_science_package_path(current_file: Path) -> Path:
    repository_root = Path(os.environ.get("GEO_AGENT_PLATFORM_REPOSITORY_ROOT", "")).resolve() if os.environ.get("GEO_AGENT_PLATFORM_REPOSITORY_ROOT") else find_repository_root(current_file.resolve())
    source_root = repository_root / "packages" / "gis-meteorology" / "src"
    if source_root.is_dir() and str(source_root) not in sys.path:
        sys.path.insert(0, str(source_root))
    return repository_root


def find_repository_root(start: Path) -> Path:
    """从当前文件向上查找仓库根，避免绑定固定 parents 层级。"""

    for parent in (start, *start.parents):
        if (parent / "package.json").is_file() and (parent / "packages").is_dir():
            return parent
    raise RuntimeError("无法定位 平台 仓库根目录；请设置 GEO_AGENT_PLATFORM_REPOSITORY_ROOT")

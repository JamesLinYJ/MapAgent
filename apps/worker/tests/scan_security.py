#!/usr/bin/env python3
# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 源码安全扫描
#
#   文件:       scan_security.py
#
#   日期:       2026年07月03日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

"""轻量安全扫描 —— 验证 Python 工作负载入口和适配器未引入危险模式。

排除 source/original 原始源码归档目录。
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

PATTERNS = [
    ("allow_pickle=True", "禁止 allow_pickle=True", [
        "packages/gis-meteorology/src/",
        "apps/worker/src/",
    ]),
    ("warnings.filterwarnings(", "禁止全局 warnings.filterwarnings（可能隐藏告警）", [
        "packages/gis-meteorology/src/",
        "apps/worker/src/",
    ]),
    ("os.chdir(", "禁止 os.chdir（工作目录副作用）", [
        "packages/gis-meteorology/src/",
        "apps/worker/src/",
    ]),
]

def should_exclude(file_path: Path) -> bool:
    """排除 source/original 归档目录。"""
    parts = file_path.parts
    return any(parts[index] == "source" and parts[index + 1] == "original" for index in range(len(parts) - 1))


def scan(patterns: list[tuple[str, str, list[str]]]) -> int:
    failures = 0
    for pattern, description, scan_dirs in patterns:
        for scan_dir in scan_dirs:
            root = REPO_ROOT / scan_dir
            if not root.is_dir():
                continue
            for py_file in root.rglob("*.py"):
                if should_exclude(py_file):
                    continue
                try:
                    text = py_file.read_text(encoding="utf-8")
                except Exception:
                    continue
                for lineno, line in enumerate(text.splitlines(), start=1):
                    if pattern in line:
                        print(f"FAIL: {description} @ {py_file.relative_to(REPO_ROOT)}:{lineno}")
                        failures += 1
    return failures


def main() -> None:
    print("=== Worker / GIS Python 安全扫描 ===")
    failures = scan(PATTERNS)
    if failures:
        print(f"\n发现 {failures} 个违规项。")
        sys.exit(1)
    else:
        print("未发现 allow_pickle=True / warnings.filterwarnings / os.chdir 违规。")
        sys.exit(0)


if __name__ == "__main__":
    main()

# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 工具文件引用解析
#
#   文件:       tool_io.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""Worker 工具共用的受限文件引用解析。"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator

from worker_app.path_sandbox import referenced_filename as sandbox_referenced_filename
from worker_app.path_sandbox import sequence_items
from worker_app.tool_context import WorkerToolContext


def input_path(args: dict[str, Any], context: WorkerToolContext) -> Path:
    return context.path_sandbox.input_path(args)


def input_filename(args: dict[str, Any], source: Path | None = None) -> str | None:
    for key in ("filename", "file_name", "name"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return Path(value.strip()).name
    return source.name if source is not None else None


def output_path(
    args: dict[str, Any],
    context: WorkerToolContext,
    *,
    key: str = "output_relative_path",
) -> Path:
    return context.path_sandbox.output_path(args, key=key)


def optional_referenced_path(
    args: dict[str, Any],
    context: WorkerToolContext,
    key: str,
) -> Path | None:
    return context.path_sandbox.optional_referenced_path(args, key)


def referenced_paths(args: dict[str, Any], context: WorkerToolContext, key: str) -> list[Path]:
    return context.path_sandbox.referenced_paths(args, key)


def referenced_path(value: dict[str, Any], context: WorkerToolContext) -> Path:
    return context.path_sandbox.referenced_path(value)


def radar_semantic_input_paths(
    args: dict[str, Any],
    context: WorkerToolContext,
    key: str,
) -> Iterator[list[Path]]:
    return context.path_sandbox.radar_semantic_input_paths(args, key)


def relative_runtime_path(value: Path, context: WorkerToolContext) -> str:
    return context.path_sandbox.relative_runtime_path(value)


def sequence_sources(
    args: dict[str, Any],
    context: WorkerToolContext,
) -> tuple[list[Path], list[str]]:
    items = sequence_items(args)
    paths = [referenced_path(item, context) for item in items]
    names = [sandbox_referenced_filename(item, source) for item, source in zip(items, paths)]
    return paths, names

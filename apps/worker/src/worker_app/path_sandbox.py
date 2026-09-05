# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 路径沙箱
#
#   文件:       path_sandbox.py
#
#   日期:       2026年07月08日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

"""Worker 运行时路径解析与临时语义视图。"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import shutil
import tempfile
from typing import Any, Iterator


class WorkerPathSandbox:
    """限制 Worker 只能读写 runtime 根目录内的相对路径。"""

    def __init__(self, runtime_root: Path) -> None:
        self.runtime_root = runtime_root.resolve()

    def resolve_runtime_path(self, relative: str, *, must_exist: bool) -> Path:
        candidate = Path(relative)
        if candidate.is_absolute():
            raise ValueError("Worker 禁止接收绝对路径")
        resolved = (self.runtime_root / candidate).resolve()
        if resolved != self.runtime_root and self.runtime_root not in resolved.parents:
            raise ValueError("文件引用越出共享 runtime 根目录")
        if must_exist and not resolved.exists():
            raise FileNotFoundError(f"文件不存在: {candidate.as_posix()}")
        return resolved

    def referenced_path(self, value: dict[str, Any]) -> Path:
        relative = value.get("relativePath") or value.get("file_relative_path")
        if not isinstance(relative, str) or not relative.strip():
            raise ValueError("文件引用缺少 relativePath")
        return self.resolve_runtime_path(relative, must_exist=True)

    def referenced_paths(self, args: dict[str, Any], key: str) -> list[Path]:
        items = args.get(key)
        if not isinstance(items, list) or not items:
            raise ValueError(f"{key} 必须是非空文件引用数组")
        paths = []
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValueError(f"{key}[{index}] 必须是对象")
            paths.append(self.referenced_path(item))
        return paths

    def optional_referenced_path(self, args: dict[str, Any], key: str) -> Path | None:
        value = args.get(key)
        if value is None:
            return None
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{key} 必须是非空字符串")
        return self.referenced_path({"relativePath": value})

    def input_path(self, args: dict[str, Any]) -> Path:
        return self.referenced_path({"relativePath": required_text(args, "file_relative_path")})

    def output_path(self, args: dict[str, Any], *, key: str = "output_relative_path") -> Path:
        relative = required_text(args, key)
        target = self.resolve_runtime_path(relative, must_exist=False)
        target.parent.mkdir(parents=True, exist_ok=True)
        return target

    def relative_runtime_path(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.runtime_root).as_posix()
        except ValueError as exc:
            raise ValueError("输出路径越出共享 runtime 根目录") from exc

    @contextmanager
    def radar_semantic_input_paths(self, args: dict[str, Any], key: str) -> Iterator[list[Path]]:
        """为依赖文件名和父目录语义的雷达算法重建临时输入视图。"""

        items = sequence_items({key: args.get(key)}) if key == "files" else file_reference_items(args, key)
        with tempfile.TemporaryDirectory(prefix="geo-agent-platform-radar-input-") as tmp:
            root = Path(tmp)
            aliases: list[Path] = []
            for index, item in enumerate(items):
                source = self.referenced_path(item)
                alias = root / radar_semantic_relative_path(item, source, index)
                alias.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, alias)
                aliases.append(alias)
            yield aliases


def sequence_items(args: dict[str, Any]) -> list[dict[str, Any]]:
    items = args.get("files")
    if not isinstance(items, list) or not items:
        raise ValueError("files 必须是非空数组")
    if not all(isinstance(item, dict) for item in items):
        raise ValueError("files 中每一项必须是对象")
    return items


def file_reference_items(args: dict[str, Any], key: str) -> list[dict[str, Any]]:
    items = args.get(key)
    if not isinstance(items, list) or not items:
        raise ValueError(f"{key} 必须是非空文件引用数组")
    if not all(isinstance(item, dict) for item in items):
        raise ValueError(f"{key} 中每一项必须是对象")
    return items


def referenced_filename(value: dict[str, Any], source: Path) -> str:
    for key in ("name", "filename", "fileName"):
        raw = value.get(key)
        if isinstance(raw, str) and raw.strip():
            return Path(raw.strip()).name
    return source.name


def radar_semantic_relative_path(value: dict[str, Any], source: Path, index: int) -> Path:
    """把平台文件引用投影成雷达算法需要的“站点目录/原始文件名”结构。"""

    raw_relative = value.get("sourceRelativePath")
    filename = referenced_filename(value, source)
    if isinstance(raw_relative, str) and raw_relative.strip():
        semantic = safe_relative_path(raw_relative.strip())
        if semantic.name:
            return Path(f"{index + 1:04d}") / semantic
    station = radar_station_from_filename(filename)
    return Path(f"{index + 1:04d}") / (station or f"station_{index + 1}") / safe_path_segment(filename)


def safe_relative_path(value: str) -> Path:
    candidate = Path(value)
    if candidate.is_absolute():
        raise ValueError("雷达文件 sourceRelativePath 不能是绝对路径")
    clean_parts: list[str] = []
    for part in candidate.parts:
        if part in {"", ".", ".."}:
            if part == "..":
                raise ValueError("雷达文件 sourceRelativePath 不能包含上级目录")
            continue
        clean_parts.append(safe_path_segment(part))
    if not clean_parts:
        raise ValueError("雷达文件 sourceRelativePath 不能为空")
    return Path(*clean_parts)


def safe_path_segment(value: str) -> str:
    name = Path(value.strip()).name
    if not name or name in {".", ".."} or "\x00" in name:
        raise ValueError("雷达文件名不合法")
    return name


def radar_station_from_filename(filename: str) -> str | None:
    parts = filename.split("_")
    if len(parts) >= 4 and parts[0] == "Z" and parts[1] == "RADR":
        return safe_path_segment(parts[3])
    return None


def required_text(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} 必须是非空字符串")
    return value.strip()

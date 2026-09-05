# +-------------------------------------------------------------------------
#
#   地理智能平台 - xarray 数据集打开边界
#
#   文件:       xarray_io.py
#
#   日期:       2026年08月08日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""按科学文件容器签名选择唯一 xarray 后端。"""

from __future__ import annotations

from pathlib import Path
from typing import Any


HDF5_SIGNATURE = b"\x89HDF\r\n\x1a\n"
NETCDF3_CLASSIC_SIGNATURE = b"CDF\x01"
NETCDF3_64BIT_OFFSET_SIGNATURE = b"CDF\x02"
NETCDF3_64BIT_DATA_SIGNATURE = b"CDF\x05"
GRIB_SIGNATURE = b"GRIB"

GRIB_SUFFIXES = {".grib", ".grib2", ".grb", ".grb2"}
HDF5_SUFFIXES = {".h5", ".hdf5"}
NETCDF_SUFFIXES = {".nc", ".nc4"}


def open_xarray_dataset(
    xr: Any,
    path: Path,
    *,
    suffix: str | None = None,
) -> tuple[Any, str]:
    """打开科学数据集；格式与后端不匹配时保留原始异常并立即失败。"""

    engine = select_xarray_engine(path, suffix=suffix)
    kwargs: dict[str, Any] = {"engine": engine}
    if engine == "h5netcdf":
        kwargs["phony_dims"] = "access"
    try:
        return xr.open_dataset(path, **kwargs), engine
    except Exception as exc:
        raise ValueError(f"无法使用 {engine} 读取气象文件 {path.name}：{exc}") from exc


def select_xarray_engine(path: Path, *, suffix: str | None = None) -> str:
    """根据语义扩展名和容器签名确定一个后端，不执行多后端试探。"""

    normalized_suffix = _normalized_suffix(path, suffix)
    if normalized_suffix in GRIB_SUFFIXES:
        return "cfgrib"
    if normalized_suffix and normalized_suffix not in HDF5_SUFFIXES | NETCDF_SUFFIXES:
        raise ValueError(f"不支持的 xarray 气象文件格式：{normalized_suffix}")

    signature = _container_signature(path)
    if signature == "hdf5":
        return "h5netcdf"
    if signature in {"netcdf3-classic", "netcdf3-64bit-offset"}:
        if normalized_suffix in HDF5_SUFFIXES:
            raise ValueError(f"文件扩展名 {normalized_suffix} 与 NetCDF3 容器不一致。")
        return "scipy"
    if signature == "netcdf3-64bit-data":
        if normalized_suffix in HDF5_SUFFIXES:
            raise ValueError(f"文件扩展名 {normalized_suffix} 与 CDF-5 容器不一致。")
        return "netcdf4"
    if signature == "grib" and not normalized_suffix:
        return "cfgrib"

    suffix_label = normalized_suffix or "无扩展名"
    raise ValueError(f"无法识别气象文件容器签名（{suffix_label}）：{path.name}")


def effective_suffix(path: Path, filename: str | None = None) -> str:
    """内容寻址路径无扩展名时，以已校验的原始文件名补齐格式语义。"""

    path_suffix = path.suffix.lower()
    return path_suffix or Path(filename or "").suffix.lower()


def _normalized_suffix(path: Path, suffix: str | None) -> str:
    value = suffix if suffix is not None else path.suffix
    normalized = value.strip().lower()
    if normalized and not normalized.startswith("."):
        normalized = f".{normalized}"
    return normalized


def _container_signature(path: Path) -> str | None:
    try:
        size = path.stat().st_size
        with path.open("rb") as source:
            prefix = source.read(len(HDF5_SIGNATURE))
            if prefix.startswith(NETCDF3_CLASSIC_SIGNATURE):
                return "netcdf3-classic"
            if prefix.startswith(NETCDF3_64BIT_OFFSET_SIGNATURE):
                return "netcdf3-64bit-offset"
            if prefix.startswith(NETCDF3_64BIT_DATA_SIGNATURE):
                return "netcdf3-64bit-data"
            if prefix.startswith(GRIB_SIGNATURE):
                return "grib"
            if prefix == HDF5_SIGNATURE:
                return "hdf5"

            # HDF5 允许在 512×2^n 偏移处放置 superblock 签名（user block）。
            offset = 512
            while offset + len(HDF5_SIGNATURE) <= size:
                source.seek(offset)
                if source.read(len(HDF5_SIGNATURE)) == HDF5_SIGNATURE:
                    return "hdf5"
                offset *= 2
    except OSError as exc:
        raise ValueError(f"无法读取气象文件头 {path.name}：{exc}") from exc
    return None

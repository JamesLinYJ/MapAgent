# +-------------------------------------------------------------------------
#
#   地理智能平台 - 天气雷达径向数据解码
#
#   文件:       radar.py
#
#   日期:       2026年06月25日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

# 模块职责
#
# 包装第三方解码器，输出平台统一的气象变量和地图范围事实。
# 这里不浏览本机目录，也不吞掉解码错误；不可解析的文件必须明确失败。

from __future__ import annotations

import bz2
import logging
from dataclasses import dataclass
from pathlib import Path
import struct
from typing import Any

logger = logging.getLogger("gis_meteorology.radar")

from .third_party.common import import_source_module


SOURCE_DIR = Path(__file__).resolve().parent / "third_party" / "radar_mosaic_agent" / "source"


@dataclass(frozen=True)
class RadarProduct:
    name: str
    data: Any
    unit: str
    long_name: str
    elevations: list[float]


@dataclass(frozen=True)
class DecodedRadar:
    path: Path
    latitude: float
    longitude: float
    height_m: float | None
    radar_type: int | None
    range_km: float
    bounds: list[float]
    products: dict[str, RadarProduct]


PRODUCT_DEFINITIONS: dict[str, tuple[str, str, str, str]] = {
    "reflectivity": ("reflectivity", "dBZ", "反射率因子", "ref"),
    "velocity": ("velocity", "m/s", "径向速度", "vel"),
    "spectrum_width": ("spectrum_width", "m/s", "谱宽", "vel"),
    "zdr": ("zdr", "dB", "差分反射率", "ref"),
    "cc": ("cc", "1", "协相关系数", "ref"),
    "dp": ("dp", "deg", "差分相位", "ref"),
    "kdp": ("kdp", "deg/km", "差分相位常数", "ref"),
    "snrh": ("snrh", "dB", "水平信噪比", "ref"),
}


def decode_radar_bz2(path: Path) -> DecodedRadar:
    """Decode one explicit runtime radar bz2 file into typed product arrays."""

    if path.suffix.lower() != ".bz2":
        raise ValueError(f"天气雷达径向数据必须是 .bz2 文件：{path.name}")
    np = _np()
    decoder = import_source_module("radar_decoder", SOURCE_DIR)
    result = decoder.decoderaw(f"{path.parent.as_posix()}/", path.name)
    if not isinstance(result, tuple) or len(result) != 12 or result[0] is None:
        raise ValueError(f"雷达文件无法解码：{path.name}")
    ref, vel, spw, zdr, cc, dp, kdp, snrh, level_ref, level_vel, latitude, longitude = result
    header = _read_header(path)
    arrays = {
        "reflectivity": ref,
        "velocity": vel,
        "spectrum_width": spw,
        "zdr": zdr,
        "cc": cc,
        "dp": dp,
        "kdp": kdp,
        "snrh": snrh,
    }
    products: dict[str, RadarProduct] = {}
    for key, values in arrays.items():
        data = np.asarray(values, dtype="float64") if values is not None else np.asarray([])
        if data.ndim != 3 or data.shape[0] == 0 or data.shape[1] == 0 or data.shape[2] == 0:
            continue
        name, unit, long_name, level_kind = PRODUCT_DEFINITIONS[key]
        elevations = _elevations(level_ref if level_kind == "ref" else level_vel, data.shape[0])
        products[key] = RadarProduct(name=name, data=data, unit=unit, long_name=long_name, elevations=elevations)
    if not products:
        raise ValueError(f"雷达文件没有可用产品：{path.name}")
    range_km = max(float(product.data.shape[-1] - 1) for product in products.values())
    bounds = _radar_bounds(float(latitude), float(longitude), range_km)
    return DecodedRadar(
        path=path,
        latitude=float(latitude),
        longitude=float(longitude),
        height_m=header.get("height_m"),
        radar_type=int(header["radar_type"]) if header.get("radar_type") is not None else None,
        range_km=range_km,
        bounds=bounds,
        products=products,
    )


def radar_product_to_grid(
    decoded: DecodedRadar,
    *,
    variable: str | None,
    elevation_index: int | None,
) -> tuple[Any, Any, Any, RadarProduct, int]:
    """Select a decoded radar product and return data plus generated coordinates."""

    np = _np()
    product_key = _select_product(decoded.products, variable)
    product = decoded.products[product_key]
    selected_index = int(elevation_index or 0)
    if selected_index < 0 or selected_index >= product.data.shape[0]:
        raise ValueError(f"雷达产品 {product.name} 没有仰角索引 {selected_index}")
    radial_data = np.asarray(product.data[selected_index], dtype="float64")
    data, lat, lon = _polar_to_cartesian_grid(
        radial_data,
        latitude=decoded.latitude,
        longitude=decoded.longitude,
    )
    return data, lat, lon, product, selected_index


def _select_product(products: dict[str, RadarProduct], variable: str | None) -> str:
    if variable:
        normalized = variable.strip().casefold()
        for key, product in products.items():
            if normalized in {key.casefold(), product.name.casefold(), product.long_name.casefold()}:
                return key
        raise ValueError(f"未知雷达产品：{variable}")
    if "reflectivity" in products:
        return "reflectivity"
    return next(iter(products))


def _polar_to_cartesian_grid(
    radial_data: Any,
    *,
    latitude: float,
    longitude: float,
) -> tuple[Any, Any, Any]:
    """把等方位径向矩阵按最近邻采样到规则 WGS84 笛卡尔网格。"""

    np = _np()
    values = np.asarray(radial_data, dtype="float64")
    if values.ndim != 2 or values.shape[0] < 1 or values.shape[1] < 2:
        raise ValueError("雷达径向切片必须是至少包含两个距离库的二维矩阵。")
    azimuth_count, range_count = values.shape
    range_km = float(range_count - 1)
    grid_size = range_count * 2 - 1
    x_axis_km = np.linspace(-range_km, range_km, grid_size)
    y_axis_km = np.linspace(range_km, -range_km, grid_size)
    x_grid_km, y_grid_km = np.meshgrid(x_axis_km, y_axis_km)
    radius_km = np.hypot(x_grid_km, y_grid_km)
    azimuth_deg = np.mod(np.degrees(np.arctan2(x_grid_km, y_grid_km)), 360.0)
    azimuth_indices = np.rint(azimuth_deg * azimuth_count / 360.0).astype("int64") % azimuth_count
    range_indices = np.rint(radius_km).astype("int64")
    inside = range_indices < range_count
    cartesian = np.full((grid_size, grid_size), np.nan, dtype="float64")
    cartesian[inside] = values[azimuth_indices[inside], range_indices[inside]]

    lat = latitude + y_axis_km / 111.32
    lon_scale = max(0.1, 111.32 * np.cos(np.deg2rad(latitude)))
    lon = longitude + x_axis_km / lon_scale
    return cartesian, lat, lon


def _radar_bounds(latitude: float, longitude: float, range_km: float) -> list[float]:
    np = _np()
    lat_delta = range_km / 111.32
    lon_delta = range_km / max(0.1, 111.32 * np.cos(np.deg2rad(latitude)))
    return [
        float(longitude - lon_delta),
        float(latitude - lat_delta),
        float(longitude + lon_delta),
        float(latitude + lat_delta),
    ]


def _elevations(values: Any, expected: int) -> list[float]:
    np = _np()
    array = np.asarray(values, dtype="float64").ravel()
    if array.size < expected or not np.isfinite(array[:expected]).all():
        raise ValueError(f"雷达产品缺少 {expected} 层有效仰角信息。")
    return [float(item) for item in array[:expected]]


def _read_header(path: Path) -> dict[str, float | int | None]:
    try:
        with bz2.BZ2File(path, "rb") as file:
            filedata = file.read(160)
        if len(filedata) < 106:
            return {"height_m": None, "radar_type": None}
        return {
            "height_m": float(struct.unpack("<i", filedata[80:84])[0]),
            "radar_type": int(struct.unpack("<h", filedata[104:106])[0]),
        }
    except (struct.error, IndexError, EOFError, OSError) as exc:
        logger.warning("雷达文件头解析失败 %s: %s", path, exc)
        return {"height_m": None, "radar_type": None}


def _np() -> Any:
    import numpy as np
    return np

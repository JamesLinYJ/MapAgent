# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象数据解析服务
#
#   文件:       service.py
#
#   日期:       2026年05月20日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

# 维护记录 (2026-08-08):
# 协助: OpenAI Codex:GPT-5.6 Sol
# 说明: 服务层收敛为业务编排，所有科学数据读取统一委托 Reader 门面。

# 模块职责
#
# 解析 NetCDF / GRIB / HDF5 / GeoTIFF / 雷达原始数据等气象科学数据，
# 并把多维数组转成平台可消费的 metadata、PNG 热力图、GeoJSON 阈值区和等值线。

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .radar import decode_radar_bz2, radar_product_to_grid
from .readers import (
    GridQuery,
    GridSlice,
    MeteorologicalDatasetIndex,
    MeteorologicalReaderFacade,
    area_union as _area_union,
    bounds_from_coords as _bounds_from_coords,
    coord_edges as _coord_edges,
    crop_grid_with_coords_by_bbox as _crop_grid_with_coords_by_bbox,
    finite_range as _finite_range,
    finite_values as _finite_values,
    mask_grid_to_area as _mask_grid_to_area,
    require_1d_lat_lon_values as _require_1d_lat_lon_values,
)
from .report import write_meteorological_report_docx
from .xarray_io import effective_suffix as _effective_suffix

SUPPORTED_METEOROLOGICAL_SUFFIXES = {".nc", ".nc4", ".tif", ".tiff", ".grib", ".grib2", ".grb", ".grb2", ".h5", ".hdf5", ".bz2"}


def is_supported_meteorological_file(filename: str) -> bool:
    return Path(filename).suffix.lower() in SUPPORTED_METEOROLOGICAL_SUFFIXES


def _write_cog(output_path: Path, data: Any, bounds: list[float]) -> None:
    """把已完成地理定向的二维科学网格写为带数值语义的 WGS84 COG。"""
    array = _np().asarray(data, dtype="float32")
    if array.ndim != 2 or array.shape[0] < 1 or array.shape[1] < 1:
        raise ValueError("COG 输出要求非空二维网格。")
    west, south, east, north = bounds
    transform = _rasterio_transform().from_bounds(west, south, east, north, array.shape[1], array.shape[0])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with _rasterio().open(
        output_path,
        "w",
        driver="COG",
        height=array.shape[0],
        width=array.shape[1],
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=transform,
        nodata=float("nan"),
        compress="DEFLATE",
        blocksize=512,
        overview_resampling="AVERAGE",
        bigtiff="IF_SAFER",
    ) as dataset:
        dataset.write(array, 1)


@dataclass(frozen=True)
class MeteorologicalGrid:
    # 运行时网格切片
    #
    # data 是二维数值矩阵；lat/lon 为一维坐标时可做阈值区和等值线，
    # bounds 则是 raster overlay 的最小地图定位事实。
    data: Any
    variable: str
    unit: str | None
    long_name: str | None
    time_value: str | None
    level_value: str | None
    lat: Any | None
    lon: Any | None
    bounds: list[float] | None
    source_kind: str


class MeteorologicalDataService:
    def __init__(self, *, reader_facade: MeteorologicalReaderFacade | None = None):
        # 统一 reader 门面。
        #
        # 新能力优先走 GridQuery/GridSlice；旧 API 继续保持返回形态兼容，
        # 让短时临近预报（短临）和普通气象分析共享同一套读取抽象。
        self.reader_facade = reader_facade or MeteorologicalReaderFacade()

    def inspect_index(self, path: Path, *, filename: str | None = None) -> MeteorologicalDatasetIndex:
        return self.reader_facade.inspect(path, filename=filename)

    def read_grid_slice(self, path: Path, query: GridQuery, *, filename: str | None = None) -> GridSlice:
        return self.reader_facade.read_slice(path, query, filename=filename)

    def inspect(self, path: Path, *, filename: str | None = None) -> dict[str, Any]:
        # 文件画像入口。
        #
        # 解析阶段只输出轻量 metadata；原始数组继续留在 runtime 文件里，
        # 后续 render/stats/threshold/contours 再按需读取。
        suffix = _effective_suffix(path, filename)
        if suffix not in SUPPORTED_METEOROLOGICAL_SUFFIXES:
            raise ValueError(f"不支持的气象文件格式：{suffix or 'unknown'}")
        if suffix == ".bz2":
            return self._inspect_radar(path, filename=filename)
        return self.inspect_index(path, filename=filename).to_metadata()

    def render_heatmap(
        self,
        path: Path,
        *,
        output_path: Path,
        cog_output_path: Path,
        filename: str | None = None,
        variable: str | None = None,
        time_index: int | None = None,
        level_index: int | None = None,
        bbox: list[float] | None = None,
        area: dict[str, Any] | None = None,
        max_size: int = 1024,
    ) -> dict[str, Any]:
        grid = self._read_map_grid(path, filename=filename, variable=variable, time_index=time_index, level_index=level_index, max_size=max_size)
        if not grid.bounds:
            raise ValueError("该气象变量没有可用地理范围，无法渲染到地图。")
        _require_regular_map_coordinates(grid.data, grid.lat, grid.lon)
        data, lat, lon = _crop_grid_with_coords_by_bbox(grid.data, grid.lat, grid.lon, bbox)
        data = _mask_grid_to_area(data, lat, lon, area)
        data, lat, lon = _downsample_grid_for_render(data, lat, lon, max_size=max_size)
        bounds = _bounds_from_coords(lat, lon) or grid.bounds
        data, bounds = _orient_grid_for_map(data, lat, lon, bounds)
        if _finite_range(data) is None:
            raise ValueError("分析区域与该气象变量没有重叠像元，无法渲染地图。")
        image = _colorize_grid(data)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path)
        _write_cog(cog_output_path, data, bounds)
        finite_range = _finite_range(data)
        if finite_range is None:
            raise ValueError("分析区域没有可用于制图的有限数值。")
        value_range = {"min": finite_range[0], "max": finite_range[1]}
        west, south, east, north = bounds
        return {
            "variable": grid.variable,
            "unit": grid.unit,
            "longName": grid.long_name,
            "timeValue": grid.time_value,
            "levelValue": grid.level_value,
            "bounds": bounds,
            "coordinates": [[west, north], [east, north], [east, south], [west, south]],
            "valueRange": value_range,
            "width": image.width,
            "height": image.height,
            "cogWidth": int(data.shape[1]),
            "cogHeight": int(data.shape[0]),
            "backend": grid.source_kind,
        }

    def stats(
        self,
        path: Path,
        *,
        filename: str | None = None,
        variable: str | None = None,
        time_index: int | None = None,
        level_index: int | None = None,
        bbox: list[float] | None = None,
        area: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        grid = self.read_grid(path, filename=filename, variable=variable, time_index=time_index, level_index=level_index)
        data, lat, lon = _crop_grid_with_coords_by_bbox(grid.data, grid.lat, grid.lon, bbox)
        data = _mask_grid_to_area(data, lat, lon, area)
        values = _finite_values(data)
        if values.size == 0:
            return {
                "variable": grid.variable,
                "unit": grid.unit,
                "timeValue": grid.time_value,
                "levelValue": grid.level_value,
                "count": 0,
            }
        median = float(_np().percentile(values, 50))
        return {
            "variable": grid.variable,
            "unit": grid.unit,
            "longName": grid.long_name,
            "timeValue": grid.time_value,
            "levelValue": grid.level_value,
            "count": int(values.size),
            "min": float(values.min()),
            "max": float(values.max()),
            "mean": float(values.mean()),
            "median": median,
            "p50": median,
            "p90": float(_np().percentile(values, 90)),
        }

    def threshold_geojson(
        self,
        path: Path,
        *,
        threshold: float,
        operator: str = ">=",
        filename: str | None = None,
        variable: str | None = None,
        time_index: int | None = None,
        level_index: int | None = None,
        bbox: list[float] | None = None,
        area: dict[str, Any] | None = None,
        max_cells: int = 20000,
    ) -> dict[str, Any]:
        grid = self.read_grid(path, filename=filename, variable=variable, time_index=time_index, level_index=level_index)
        data, cropped_lat, cropped_lon = _crop_grid_with_coords_by_bbox(grid.data, grid.lat, grid.lon, bbox)
        data = _mask_grid_to_area(data, cropped_lat, cropped_lon, area)
        lat, lon = _require_1d_lat_lon_values(data, cropped_lat, cropped_lon)
        mask = _compare(data, threshold, operator)
        selected_count = int(_np().count_nonzero(mask))
        if selected_count == 0:
            return {"type": "FeatureCollection", "features": []}
        if selected_count > max_cells:
            raise ValueError(f"阈值命中 {selected_count} 个网格，超过当前上限 {max_cells}，请先缩小范围或提高阈值。")

        lat_edges = _coord_edges(lat)
        lon_edges = _coord_edges(lon)
        geometry_module = _shapely_geometry()
        polygons = []
        rows, cols = _np().where(mask)
        for row, col in zip(rows.tolist(), cols.tolist(), strict=False):
            south, north = sorted((float(lat_edges[row]), float(lat_edges[row + 1])))
            west, east = sorted((float(lon_edges[col]), float(lon_edges[col + 1])))
            polygons.append(geometry_module.box(west, south, east, north))
        merged = _shapely_ops().unary_union(polygons)
        if area is not None:
            merged = merged.intersection(_area_union(area))
        if merged.is_empty:
            return {"type": "FeatureCollection", "features": []}
        return {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "variable": grid.variable,
                        "unit": grid.unit,
                        "threshold": threshold,
                        "operator": operator,
                        "cell_count": selected_count,
                        "time_value": grid.time_value,
                        "level_value": grid.level_value,
                    },
                    "geometry": geometry_module.mapping(merged),
                }
            ],
        }

    def contours_geojson(
        self,
        path: Path,
        *,
        levels: list[float] | None = None,
        filename: str | None = None,
        variable: str | None = None,
        time_index: int | None = None,
        level_index: int | None = None,
        bbox: list[float] | None = None,
        area: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        contourpy = _contourpy()
        grid = self.read_grid(path, filename=filename, variable=variable, time_index=time_index, level_index=level_index)
        data, cropped_lat, cropped_lon = _crop_grid_with_coords_by_bbox(grid.data, grid.lat, grid.lon, bbox)
        area_geom = _area_union(area) if area is not None else None
        data = _mask_grid_to_area(data, cropped_lat, cropped_lon, area)
        lat, lon = _require_1d_lat_lon_values(data, cropped_lat, cropped_lon)
        data, lat, lon = _orient_grid_for_contours(data, lat, lon)
        finite_range = _finite_range(data)
        if finite_range is None:
            return {"type": "FeatureCollection", "features": []}
        if not levels:
            low, high = finite_range
            if math.isclose(low, high):
                levels = [low]
            else:
                levels = [float(item) for item in _np().linspace(low, high, 7)[1:-1]]

        generator = contourpy.contour_generator(x=lon, y=lat, z=data, name="serial")
        features: list[dict[str, Any]] = []
        for level in levels:
            for line in generator.lines(float(level)):
                if len(line) < 2:
                    continue
                geometry = _shapely_geometry().LineString([(float(x), float(y)) for x, y in line])
                if area_geom is not None:
                    geometry = geometry.intersection(area_geom)
                if geometry.is_empty:
                    continue
                features.extend(
                    _geometry_to_features(
                        geometry,
                        properties={
                            "variable": grid.variable,
                            "unit": grid.unit,
                            "level": float(level),
                            "time_value": grid.time_value,
                            "level_value": grid.level_value,
                        },
                    )
                )
        return {"type": "FeatureCollection", "features": features}

    def generate_report_docx(
        self,
        path: Path,
        *,
        output_path: Path,
        filename: str | None = None,
        dataset_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        llm_interpretation: str = "",
        max_variables: int = 12,
        stats_variable_limit: int = 8,
    ) -> dict[str, Any]:
        # 正式解读报告。
        #
        # 报告事实来源只包括 inspect metadata 和按变量读取的统计切片；
        # 不读取 Agent 历史，也不把无法统计的变量伪装成成功结论。
        if not llm_interpretation.strip():
            raise ValueError("生成 DOCX 解读报告必须提供大模型解读正文。")
        report_metadata = metadata if isinstance(metadata, dict) and metadata.get("variables") else self.inspect(path, filename=filename)
        variables = _report_variables(report_metadata, limit=max_variables)
        stats_rows: list[dict[str, Any]] = []
        for variable in variables[: max(0, int(stats_variable_limit))]:
            name = str(variable.get("name") or "").strip()
            if not name or not variable.get("analysisReady", True):
                continue
            try:
                stats_rows.append(self.stats(path, filename=filename, variable=name))
            except Exception as exc:
                stats_rows.append({"variable": name, "error": str(exc).strip() or exc.__class__.__name__})
        return write_meteorological_report_docx(
            output_path=output_path,
            dataset_id=dataset_id,
            filename=filename or path.name,
            metadata={**report_metadata, "variables": variables},
            stats_rows=stats_rows,
            llm_interpretation=llm_interpretation.strip(),
            generated_at=now_report_timestamp(),
        )

    def read_grid(
        self,
        path: Path,
        *,
        filename: str | None = None,
        variable: str | None = None,
        time_index: int | None = None,
        level_index: int | None = None,
    ) -> MeteorologicalGrid:
        suffix = _effective_suffix(path, filename)
        if suffix not in SUPPORTED_METEOROLOGICAL_SUFFIXES:
            raise ValueError(f"不支持的气象文件格式：{suffix or 'unknown'}")
        if suffix == ".bz2":
            return self._read_radar_grid(path, variable=variable, elevation_index=time_index)
        return _grid_from_slice(
            self.read_grid_slice(
                path,
                GridQuery(
                    variable=variable,
                    time_index=time_index,
                    level_index=level_index,
                    purpose="analysis",
                ),
                filename=filename,
            )
        )

    def _read_map_grid(
        self,
        path: Path,
        *,
        filename: str | None,
        variable: str | None,
        time_index: int | None,
        level_index: int | None,
        max_size: int,
    ) -> MeteorologicalGrid:
        suffix = _effective_suffix(path, filename)
        if suffix not in SUPPORTED_METEOROLOGICAL_SUFFIXES:
            raise ValueError(f"不支持的气象文件格式：{suffix or 'unknown'}")
        if suffix == ".bz2":
            return self._read_radar_grid(path, variable=variable, elevation_index=time_index)
        return _grid_from_slice(
            self.read_grid_slice(
                path,
                GridQuery(
                    variable=variable,
                    time_index=time_index,
                    level_index=level_index,
                    purpose="render",
                    max_size=max_size,
                ),
                filename=filename,
            )
        )

    def _inspect_radar(self, path: Path, *, filename: str | None) -> dict[str, Any]:
        decoded = decode_radar_bz2(path)
        variables = []
        for product in decoded.products.values():
            variables.append(
                {
                    "name": product.name,
                    "dimensions": ["elevation", "azimuth", "range"],
                    "shape": [int(item) for item in product.data.shape],
                    "dataType": str(product.data.dtype),
                    "unit": product.unit,
                    "longName": product.long_name,
                    "valueRange": _finite_range(product.data),
                    "timeCount": len(product.elevations),
                    "levelCount": 0,
                    "mapReady": True,
                    "analysisReady": True,
                    "preferredBackend": "radar",
                    "backends": [{"name": "radar", "analysisReady": True, "mapReady": True, "bounds": decoded.bounds}],
                    "elevations": product.elevations,
                }
            )
        return {
            "filename": filename or path.name,
            "format": "Radar BZ2 Raw",
            "engine": "gis_meteorology.radar",
            "variables": variables,
            "coordinates": {"latitude": "generated_lat", "longitude": "generated_lon", "time": "elevation_index", "level": None},
            "times": [f"{value:.2f}°" for value in next(iter(decoded.products.values())).elevations],
            "levels": [],
            "bounds": decoded.bounds,
            "isGeoreferenced": True,
            "radar": {
                "latitude": decoded.latitude,
                "longitude": decoded.longitude,
                "heightM": decoded.height_m,
                "radarType": decoded.radar_type,
                "rangeKm": decoded.range_km,
            },
            "warnings": ["雷达原始径向数据已按站点和量程转换为近似 WGS84 笛卡尔网格，用于第一版地图叠加与统计。"],
        }

    def _read_radar_grid(self, path: Path, *, variable: str | None, elevation_index: int | None) -> MeteorologicalGrid:
        decoded = decode_radar_bz2(path)
        data, lat, lon, product, selected_index = radar_product_to_grid(decoded, variable=variable, elevation_index=elevation_index)
        elevation_value = product.elevations[selected_index] if selected_index < len(product.elevations) else None
        return MeteorologicalGrid(
            data=data,
            variable=product.name,
            unit=product.unit,
            long_name=product.long_name,
            time_value=f"{elevation_value:.2f}°" if elevation_value is not None else None,
            level_value=None,
            lat=lat,
            lon=lon,
            bounds=decoded.bounds,
            source_kind="radar_bz2",
        )


def _grid_from_slice(grid_slice: GridSlice) -> MeteorologicalGrid:
    return MeteorologicalGrid(
        data=grid_slice.data,
        variable=grid_slice.variable,
        unit=grid_slice.unit,
        long_name=grid_slice.long_name,
        time_value=grid_slice.time_value,
        level_value=grid_slice.level_value,
        lat=grid_slice.lat,
        lon=grid_slice.lon,
        bounds=grid_slice.bounds,
        source_kind=grid_slice.backend,
    )


def _report_variables(metadata: dict[str, Any], *, limit: int) -> list[dict[str, Any]]:
    raw_variables = metadata.get("variables")
    if not isinstance(raw_variables, list):
        return []
    variables = [item for item in raw_variables if isinstance(item, dict)]
    return variables[: max(1, int(limit or 12))]


def now_report_timestamp() -> str:
    return datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def _downsample_grid_for_render(data: Any, lat: Any | None, lon: Any | None, *, max_size: int) -> tuple[Any, Any | None, Any | None]:
    np = _np()
    values = np.asarray(data, dtype="float64")
    if values.ndim != 2:
        return values, lat, lon
    max_size = max(1, int(max_size or 1024))
    stride = max(1, int(math.ceil(max(values.shape[0] / max_size, values.shape[1] / max_size))))
    if stride <= 1:
        return values, lat, lon
    sampled = values[::stride, ::stride]
    sampled_lat = _sample_coord_for_stride(lat, stride, target_shape=values.shape)
    sampled_lon = _sample_coord_for_stride(lon, stride, target_shape=values.shape)
    return sampled, sampled_lat, sampled_lon


def _sample_coord_for_stride(coord: Any | None, stride: int, *, target_shape: tuple[int, int]) -> Any | None:
    if coord is None:
        return None
    np = _np()
    values = np.asarray(coord)
    if values.ndim == 1:
        return values[::stride]
    if values.ndim == 2 and values.shape == target_shape:
        return values[::stride, ::stride]
    return coord


def _orient_grid_for_map(data: Any, lat: Any | None, lon: Any | None, bounds: list[float]) -> tuple[Any, list[float]]:
    np = _np()
    result = np.asarray(data, dtype="float64")
    if lat is not None:
        lat_values = np.asarray(lat)
        if lat_values.ndim == 1 and lat_values.size > 1 and float(lat_values[0]) < float(lat_values[-1]):
            result = np.flipud(result)
    if lon is not None:
        lon_values = np.asarray(lon)
        if lon_values.ndim == 1 and lon_values.size > 1 and float(lon_values[0]) > float(lon_values[-1]):
            result = np.fliplr(result)
    return result, bounds


def _require_regular_map_coordinates(data: Any, lat: Any | None, lon: Any | None) -> None:
    if lat is None and lon is None:
        return
    if lat is None or lon is None:
        raise ValueError("地图渲染需要同时提供经度和纬度坐标。")
    np = _np()
    if np.asarray(lat).ndim != 1 or np.asarray(lon).ndim != 1:
        raise ValueError("二维曲线经纬网格不能直接铺成矩形图层，请先通过 Rasterio/GDAL 重投影。")
    lat_values, lon_values = _require_1d_lat_lon_values(data, lat, lon)
    _coord_edges(lat_values)
    _coord_edges(lon_values)


def _orient_grid_for_contours(data: Any, lat: Any, lon: Any) -> tuple[Any, Any, Any]:
    np = _np()
    result = np.asarray(data, dtype="float64")
    lat_values = np.asarray(lat, dtype="float64").ravel()
    lon_values = np.asarray(lon, dtype="float64").ravel()
    if lat_values.size > 1 and lat_values[0] > lat_values[-1]:
        lat_values = lat_values[::-1]
        result = np.flipud(result)
    if lon_values.size > 1 and lon_values[0] > lon_values[-1]:
        lon_values = lon_values[::-1]
        result = np.fliplr(result)
    return result, lat_values, lon_values


def _colorize_grid(data: Any) -> Any:
    np = _np()
    Image = _pil_image()
    values = np.asarray(data, dtype="float64")
    finite = np.isfinite(values)
    rgba = np.zeros((*values.shape, 4), dtype=np.uint8)
    if not finite.any():
        return Image.fromarray(rgba, mode="RGBA")
    vmin = float(np.nanmin(values))
    vmax = float(np.nanmax(values))
    if math.isclose(vmin, vmax):
        normalized = np.zeros(values.shape, dtype="float64")
    else:
        normalized = np.clip((values - vmin) / (vmax - vmin), 0, 1)
    palette = np.asarray(
        [
            [49, 54, 149],
            [69, 117, 180],
            [116, 173, 209],
            [171, 217, 233],
            [224, 243, 248],
            [254, 224, 144],
            [253, 174, 97],
            [244, 109, 67],
            [215, 48, 39],
            [165, 0, 38],
        ],
        dtype="float64",
    )
    # 空值像元保持透明，不参与调色板索引计算。
    #
    # 雷达极坐标转方形图时外圈天然是 NaN；先把这些位置压到 0，
    # 再通过 alpha 通道隐藏，避免 NumPy 将 NaN cast 成越界整数。
    scaled = np.where(finite, normalized, 0.0) * (len(palette) - 1)
    low = np.floor(scaled).astype(int)
    high = np.clip(low + 1, 0, len(palette) - 1)
    fraction = (scaled - low)[..., None]
    rgb = palette[low] * (1 - fraction) + palette[high] * fraction
    rgba[..., :3] = rgb.astype(np.uint8)
    rgba[..., 3] = np.where(finite, 210, 0).astype(np.uint8)
    return Image.fromarray(rgba, mode="RGBA")


def _geometry_to_features(geometry: Any, *, properties: dict[str, Any]) -> list[dict[str, Any]]:
    if geometry.is_empty:
        return []
    if geometry.geom_type in {"LineString", "MultiLineString", "Polygon", "MultiPolygon", "Point", "MultiPoint"}:
        return [{"type": "Feature", "properties": dict(properties), "geometry": _shapely_geometry().mapping(geometry)}]
    features: list[dict[str, Any]] = []
    for item in getattr(geometry, "geoms", []):
        features.extend(_geometry_to_features(item, properties=properties))
    return features


def _compare(data: Any, threshold: float, operator: str) -> Any:
    np = _np()
    values = np.asarray(data, dtype="float64")
    if operator in {">", "gt"}:
        return values > threshold
    if operator in {"<", "lt"}:
        return values < threshold
    if operator in {"<=", "lte"}:
        return values <= threshold
    if operator in {"==", "eq"}:
        return values == threshold
    if operator in {">=", "gte"}:
        return values >= threshold
    raise ValueError(f"不支持的阈值运算符：{operator}")


def _np() -> Any:
    import numpy as np
    return np


def _rasterio() -> Any:
    import rasterio
    return rasterio


def _rasterio_transform() -> Any:
    import rasterio.transform
    return rasterio.transform


def _pil_image() -> Any:
    from PIL import Image
    return Image


def _contourpy() -> Any:
    import contourpy
    return contourpy


def _shapely_geometry() -> Any:
    import shapely.geometry
    return shapely.geometry


def _shapely_ops() -> Any:
    import shapely.ops
    return shapely.ops

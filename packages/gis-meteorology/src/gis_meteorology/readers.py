# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象栅格读取抽象
#
#   文件:       readers.py
#
#   日期:       2026年05月27日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

# 维护记录 (2026-08-08):
# 协助: OpenAI Codex:GPT-5.6 Sol
# 说明: 收敛 xarray、HDF5 与 Rasterio 的确定性路由，服务层不再重复打开数据源。

# 模块职责
#
# 将 NetCDF/GeoTIFF 等气象数据读取统一成 GridQuery/GridSlice。
# xarray 负责科学维度语义，rasterio/GDAL 负责地图执行；上层服务不直接读数组。

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .xarray_io import effective_suffix, open_xarray_dataset


@dataclass(frozen=True)
class GridQuery:
    # 栅格读取请求。
    #
    # purpose 决定 reader 的执行策略：analysis 保留完整切片，render 可下采样，
    # nowcast 强调多时次小窗口读取。
    variable: str | None = None
    time_index: int | None = None
    level_index: int | None = None
    bbox: list[float] | None = None
    area: dict[str, Any] | None = None
    purpose: str = "analysis"
    max_size: int | None = None


@dataclass(frozen=True)
class GridSlice:
    data: Any
    variable: str
    unit: str | None = None
    long_name: str | None = None
    time_value: str | None = None
    level_value: str | None = None
    lat: Any | None = None
    lon: Any | None = None
    bounds: list[float] | None = None
    backend: str = "unknown"
    mask_applied: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MeteorologicalDatasetIndex:
    filename: str
    format: str
    engine: str
    variables: list[dict[str, Any]]
    coordinates: dict[str, Any]
    times: list[str] = field(default_factory=list)
    levels: list[str] = field(default_factory=list)
    bounds: list[float] | None = None
    crs: str | None = None
    is_georeferenced: bool = False
    backend_summary: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    def to_metadata(self) -> dict[str, Any]:
        metadata = {
            "filename": self.filename,
            "format": self.format,
            "engine": self.engine,
            "variables": self.variables,
            "coordinates": self.coordinates,
            "times": self.times,
            "levels": self.levels,
            "bounds": self.bounds,
            "isGeoreferenced": self.is_georeferenced,
            "backendSummary": self.backend_summary,
            "warnings": self.warnings,
        }
        if self.crs is not None:
            metadata["crs"] = self.crs
        return metadata


class MeteorologicalDatasetReader(Protocol):
    def supports(self, path: Path, *, filename: str | None = None) -> bool:
        ...

    def inspect(self, path: Path, *, filename: str | None = None) -> MeteorologicalDatasetIndex:
        ...

    def read_slice(self, path: Path, query: GridQuery, *, filename: str | None = None) -> GridSlice:
        ...


class XarrayScientificReader:
    def supports(self, path: Path, *, filename: str | None = None) -> bool:
        return effective_suffix(path, filename) in {".nc", ".nc4", ".grib", ".grib2", ".grb", ".grb2", ".h5", ".hdf5"}

    def inspect(self, path: Path, *, filename: str | None = None) -> MeteorologicalDatasetIndex:
        xr = _xarray()
        suffix = effective_suffix(path, filename)
        ds, engine = open_xarray_dataset(xr, path, suffix=suffix)
        try:
            lat_name, lon_name = _find_lat_lon_coords(ds)
            time_name = _find_time_coord(ds)
            level_name = _find_level_coord(ds)
            bounds = bounds_from_coords(ds[lat_name].values, ds[lon_name].values) if lat_name and lon_name else None
            raster_variables, raster_summary, raster_warnings = (
                _inspect_netcdf_rasterio(path) if suffix in {".nc", ".nc4"} else ({}, {}, [])
            )
            variables: list[dict[str, Any]] = []
            for name, data_array in ds.data_vars.items():
                if not _is_numeric_dtype(data_array.dtype):
                    continue
                stats = _sample_data_array_stats(data_array)
                xarray_map_ready = bool(lat_name and lon_name and _data_uses_coords(data_array, lat_name, lon_name))
                raster_meta = raster_variables.get(str(name).casefold())
                raster_map_ready = bool(raster_meta and raster_meta.get("mapReady"))
                backends = [
                    {
                        "name": "xarray",
                        "analysisReady": stats is not None,
                        "mapReady": xarray_map_ready,
                        "bounds": bounds if xarray_map_ready else None,
                    }
                ]
                if raster_meta:
                    backends.append({"name": "rasterio", "analysisReady": False, **raster_meta})
                variables.append(
                    {
                        "name": str(name),
                        "dimensions": [str(item) for item in data_array.dims],
                        "shape": [int(item) for item in data_array.shape],
                        "dataType": str(data_array.dtype),
                        "unit": _attr_text(data_array, "units"),
                        "longName": _attr_text(data_array, "long_name") or _attr_text(data_array, "standard_name"),
                        "valueRange": stats,
                        "valueRangeMode": "sampled",
                        "timeCount": _matching_dim_count(data_array, _is_time_coord),
                        "levelCount": _matching_dim_count(data_array, _is_level_coord),
                        "bounds": raster_meta.get("bounds") if raster_map_ready and raster_meta else bounds if xarray_map_ready else None,
                        "mapReady": raster_map_ready or xarray_map_ready,
                        "analysisReady": stats is not None,
                        "preferredBackend": "rasterio" if raster_map_ready else "xarray" if stats is not None else "none",
                        "backends": backends,
                    }
                )
            if not variables:
                raise ValueError("文件中没有可识别的数值型气象变量。")
            raster_bounds = next(
                (item.get("bounds") for item in raster_variables.values() if item.get("bounds")),
                None,
            )
            dataset_bounds = bounds or raster_bounds
            warnings = list(raster_warnings)
            if bounds is None and raster_bounds is None:
                warnings.insert(0, "未识别到经纬度坐标或 Rasterio 地理范围，地图叠加能力不可用。")
            elif bounds is None:
                warnings.insert(0, "未识别到 CF 经纬度坐标；地图叠加将使用 Rasterio 地理信息。")
            backend_summary: dict[str, Any] = {"xarray": {"engine": engine}}
            if suffix in {".nc", ".nc4"}:
                backend_summary["rasterio"] = raster_summary
            return MeteorologicalDatasetIndex(
                filename=filename or path.name,
                format=_format_label(suffix),
                engine=engine,
                variables=variables,
                coordinates={"latitude": lat_name, "longitude": lon_name, "time": time_name, "level": level_name},
                times=_extract_coord_values(ds, time_name),
                levels=_extract_coord_values(ds, level_name),
                bounds=dataset_bounds,
                is_georeferenced=dataset_bounds is not None,
                backend_summary=backend_summary,
                warnings=warnings,
            )
        finally:
            ds.close()

    def read_slice(self, path: Path, query: GridQuery, *, filename: str | None = None) -> GridSlice:
        xr = _xarray()
        suffix = effective_suffix(path, filename)
        if query.purpose == "render" and suffix in {".nc", ".nc4"}:
            raster_subdataset = _select_netcdf_raster_subdataset(path, query)
            if raster_subdataset is not None:
                return _read_netcdf_raster_slice(raster_subdataset, query)
        ds, _engine = open_xarray_dataset(xr, path, suffix=suffix)
        try:
            lat_name, lon_name = _find_lat_lon_coords(ds)
            variable_name = query.variable or (
                _pick_default_variable(ds, lat_name, lon_name)
                if lat_name and lon_name
                else _pick_default_numeric_variable(ds)
            )
            if variable_name not in ds.data_vars:
                raise ValueError(f"气象变量不存在：{variable_name}")
            data_array = ds[variable_name]
            selected, time_value, level_value = _select_2d_data_array(
                data_array,
                time_index=query.time_index,
                level_index=query.level_index,
            )
            selected = _transpose_to_lat_lon(selected, ds, lat_name, lon_name)
            if query.purpose == "render" and query.max_size is not None:
                selected = _thin_selected_data_array_for_render(selected, max_size=query.max_size)
            lat = selected.coords[lat_name].values if lat_name and lat_name in selected.coords else ds[lat_name].values if lat_name else None
            lon = selected.coords[lon_name].values if lon_name and lon_name in selected.coords else ds[lon_name].values if lon_name else None
            data = _np().asarray(selected.values, dtype="float64")
            data = _normalize_missing_values(data, data_array.attrs)
            data, lat, lon = crop_grid_with_coords_by_bbox(data, lat, lon, query.bbox)
            mask_applied = query.area is not None
            data = mask_grid_to_area(data, lat, lon, query.area)
            return GridSlice(
                data=data,
                variable=variable_name,
                unit=_attr_text(data_array, "units"),
                long_name=_attr_text(data_array, "long_name") or _attr_text(data_array, "standard_name"),
                time_value=time_value,
                level_value=level_value,
                lat=lat,
                lon=lon,
                bounds=bounds_from_coords(lat, lon) if lat is not None and lon is not None else None,
                backend="xarray",
                mask_applied=mask_applied,
                metadata={"purpose": query.purpose},
            )
        finally:
            ds.close()


class RasterMapReader:
    def supports(self, path: Path, *, filename: str | None = None) -> bool:
        return effective_suffix(path, filename) in {".tif", ".tiff"}

    def inspect(self, path: Path, *, filename: str | None = None) -> MeteorologicalDatasetIndex:
        rasterio = _rasterio()
        with rasterio.open(path) as src:
            bounds = _raster_bounds_wgs84(src)
            variables = []
            for band_index in range(1, src.count + 1):
                tags = src.tags(band_index)
                variables.append(
                    {
                        "name": f"band_{band_index}",
                        "dimensions": ["y", "x"],
                        "shape": [int(src.height), int(src.width)],
                        "dataType": str(src.dtypes[band_index - 1]),
                        "unit": tags.get("units") or tags.get("unit"),
                        "longName": tags.get("long_name") or tags.get("description") or f"Band {band_index}",
                        "valueRange": _raster_band_range(src, band_index),
                        "valueRangeMode": "sampled",
                        "timeCount": 0,
                        "levelCount": 0,
                        "bounds": bounds,
                        "mapReady": bounds is not None,
                        "analysisReady": True,
                        "preferredBackend": "rasterio",
                        "backends": [{"name": "rasterio", "analysisReady": True, "mapReady": bounds is not None, "bounds": bounds}],
                    }
                )
            return MeteorologicalDatasetIndex(
                filename=filename or path.name,
                format="GeoTIFF",
                engine="rasterio",
                variables=variables,
                coordinates={"latitude": "y", "longitude": "x", "time": None, "level": None},
                bounds=bounds,
                crs=str(src.crs) if src.crs else None,
                is_georeferenced=bounds is not None,
                backend_summary={"rasterio": {"available": True}},
                warnings=[] if bounds else ["GeoTIFF 缺少 CRS 或 bounds，地图叠加能力不可用。"],
            )

    def read_slice(self, path: Path, query: GridQuery, *, filename: str | None = None) -> GridSlice:
        rasterio = _rasterio()
        with rasterio.open(path) as src:
            max_size = query.max_size if query.purpose == "render" and query.max_size is not None else max(src.height, src.width)
            band_index = _band_index_from_variable(query.variable, src.count)
            resampling = _rasterio_resampling().bilinear if query.purpose == "render" else _rasterio_resampling().nearest
            data, bounds, lat, lon = _read_raster_band_as_wgs84(
                src,
                band_index=band_index,
                max_size=max_size,
                resampling=resampling,
            )
            data, lat, lon = crop_grid_with_coords_by_bbox(data, lat, lon, query.bbox)
            data = mask_grid_to_area(data, lat, lon, query.area)
            tags = src.tags(band_index)
            return GridSlice(
                data=data,
                variable=f"band_{band_index}",
                unit=tags.get("units") or tags.get("unit"),
                long_name=tags.get("long_name") or tags.get("description") or f"Band {band_index}",
                lat=lat,
                lon=lon,
                bounds=bounds_from_coords(lat, lon) if lat is not None and lon is not None else bounds,
                backend="rasterio",
                mask_applied=query.area is not None,
                metadata={"bandIndex": band_index},
            )


class Hdf5ScientificReader:
    """读取不属于 NetCDF4 容器的普通 HDF5 数值数据集。"""

    def supports(self, path: Path, *, filename: str | None = None) -> bool:
        if effective_suffix(path, filename) not in {".h5", ".hdf5"}:
            return False
        with _h5py().File(path, "r") as handle:
            return "_NCProperties" not in handle.attrs

    def inspect(self, path: Path, *, filename: str | None = None) -> MeteorologicalDatasetIndex:
        variables: list[dict[str, Any]] = []
        with _h5py().File(path, "r") as handle:
            def visit(name: str, obj: Any) -> None:
                if not hasattr(obj, "shape") or not hasattr(obj, "dtype"):
                    return
                if len(obj.shape) < 2 or not _is_numeric_dtype(obj.dtype):
                    return
                analysis_ready = len(obj.shape) <= 4
                variables.append(
                    {
                        "name": name,
                        "dimensions": [f"dim_{index}" for index in range(len(obj.shape))],
                        "shape": [int(item) for item in obj.shape],
                        "dataType": str(obj.dtype),
                        "unit": _decode_attr(_first_attr(obj.attrs, "units", "unit")),
                        "longName": _decode_attr(_first_attr(obj.attrs, "long_name", "description")),
                        "timeCount": 0,
                        "levelCount": 0,
                        "bounds": None,
                        "mapReady": False,
                        "analysisReady": analysis_ready,
                        "preferredBackend": "h5py" if analysis_ready else "none",
                        "backends": [{"name": "h5py", "analysisReady": analysis_ready, "mapReady": False, "bounds": None}],
                    }
                )

            handle.visititems(visit)
        if not variables:
            raise ValueError("HDF5 文件中没有可识别的至少二维数值数据集。")
        return MeteorologicalDatasetIndex(
            filename=filename or path.name,
            format="HDF5",
            engine="h5py",
            variables=variables,
            coordinates={"latitude": None, "longitude": None, "time": None, "level": None},
            backend_summary={"h5py": {"available": True}},
            warnings=["该 HDF5 文件没有 CF 经纬度坐标，只支持变量查看与数值统计。"],
        )

    def read_slice(self, path: Path, query: GridQuery, *, filename: str | None = None) -> GridSlice:
        selected_name: str | None = None
        selected_data: Any | None = None
        selected_attrs: dict[str, Any] = {}
        with _h5py().File(path, "r") as handle:
            def visit(name: str, obj: Any) -> None:
                nonlocal selected_name, selected_data, selected_attrs
                if selected_data is not None or not hasattr(obj, "shape") or not hasattr(obj, "dtype"):
                    return
                if len(obj.shape) < 2 or not _is_numeric_dtype(obj.dtype):
                    return
                if query.variable is not None and name != query.variable:
                    return
                if len(obj.shape) > 4:
                    if query.variable == name:
                        raise ValueError(f"HDF5 数据集 {name} 有 {len(obj.shape)} 个无语义维度，无法映射到 time/level 二维切片。")
                    return
                selection = _hdf5_2d_selection(
                    obj.shape,
                    time_index=query.time_index,
                    level_index=query.level_index,
                )
                data = _np().asarray(obj[selection], dtype="float64")
                selected_name = name
                selected_data = data
                selected_attrs = {str(key): value for key, value in obj.attrs.items()}

            handle.visititems(visit)
        if selected_data is None or selected_name is None:
            suffix = f"：{query.variable}" if query.variable else ""
            raise ValueError(f"HDF5 文件中没有可统计的二维数值数据集{suffix}")
        data = _normalize_missing_values(selected_data, selected_attrs)
        data, lat, lon = crop_grid_with_coords_by_bbox(data, None, None, query.bbox)
        data = mask_grid_to_area(data, lat, lon, query.area)
        return GridSlice(
            data=data,
            variable=selected_name,
            unit=_decode_attr(_first_attr(selected_attrs, "units", "unit")),
            long_name=_decode_attr(_first_attr(selected_attrs, "long_name", "description")),
            lat=lat,
            lon=lon,
            backend="h5py",
            mask_applied=query.area is not None,
            metadata={"purpose": query.purpose},
        )

class MeteorologicalReaderFacade:
    # Reader 路由器。
    #
    # 上层只构造 GridQuery；具体由哪个 backend 执行在这里决定。
    def __init__(self, readers: list[MeteorologicalDatasetReader] | None = None):
        self.readers = readers or [RasterMapReader(), Hdf5ScientificReader(), XarrayScientificReader()]

    def inspect(self, path: Path, *, filename: str | None = None) -> MeteorologicalDatasetIndex:
        return self._reader_for(path, filename=filename).inspect(path, filename=filename)

    def read_slice(self, path: Path, query: GridQuery, *, filename: str | None = None) -> GridSlice:
        return self._reader_for(path, filename=filename).read_slice(path, query, filename=filename)

    def _reader_for(self, path: Path, *, filename: str | None = None) -> MeteorologicalDatasetReader:
        for reader in self.readers:
            if reader.supports(path, filename=filename):
                return reader
        suffix = effective_suffix(path, filename)
        raise ValueError(f"不支持的气象文件格式：{suffix or 'unknown'}")


def _hdf5_2d_selection(
    shape: tuple[int, ...],
    *,
    time_index: int | None,
    level_index: int | None,
) -> tuple[int | slice, ...]:
    """把 HDF5 的无语义前导维索引下推到磁盘读取，只物化最终二维平面。"""

    if len(shape) < 2 or len(shape) > 4:
        raise ValueError(f"HDF5 数据集有 {len(shape)} 个无语义维度，无法映射到 time/level 二维切片。")
    requested = (int(time_index or 0), int(level_index or 0))
    leading_dimensions = len(shape) - 2
    selection: list[int | slice] = []
    for dimension, size in enumerate(shape[:leading_dimensions]):
        index = requested[dimension]
        if index < 0 or index >= int(size):
            raise ValueError(f"HDF5 维度索引超出范围：{index}")
        selection.append(index)
    selection.extend((slice(None), slice(None)))
    return tuple(selection)


def finite_values(data: Any) -> Any:
    np = _np()
    values = np.asarray(data, dtype="float64")
    return values[np.isfinite(values)]


def finite_range(data: Any) -> list[float] | None:
    values = finite_values(data)
    if values.size == 0:
        return None
    return [float(values.min()), float(values.max())]


def crop_grid_with_coords_by_bbox(data: Any, lat: Any | None, lon: Any | None, bbox: list[float] | None) -> tuple[Any, Any | None, Any | None]:
    if bbox is None:
        return data, lat, lon
    if len(bbox) != 4:
        raise ValueError("bbox 必须按 [west, south, east, north] 提供四个数值。")
    if lat is None or lon is None:
        raise ValueError("该变量没有一维经纬度坐标，无法执行 bbox 裁剪。")
    np = _np()
    west, south, east, north = [float(item) for item in bbox]
    if not np.isfinite([west, south, east, north]).all():
        raise ValueError("bbox 坐标必须是有限数值。")
    if west >= east or south >= north:
        raise ValueError("bbox 必须满足 west < east 且 south < north。")
    values = np.asarray(data)
    lat_values = np.asarray(lat, dtype="float64")
    lon_values = np.asarray(lon, dtype="float64")
    if lat_values.ndim != 1 or lon_values.ndim != 1:
        raise ValueError("该变量不是规则经纬网格，当前不支持 bbox 裁剪。")
    if values.ndim != 2 or values.shape != (lat_values.size, lon_values.size):
        raise ValueError("变量网格形状与经纬度坐标长度不一致。")
    if not np.isfinite(lat_values).all() or not np.isfinite(lon_values).all():
        raise ValueError("经纬度坐标必须是有限数值。")
    row_mask = (lat_values >= south) & (lat_values <= north)
    col_mask = (lon_values >= west) & (lon_values <= east)
    if not row_mask.any() or not col_mask.any():
        return values[:0, :0], lat_values[:0], lon_values[:0]
    row_indices = np.where(row_mask)[0]
    col_indices = np.where(col_mask)[0]
    return (
        values[np.ix_(row_indices, col_indices)],
        lat_values[row_indices],
        lon_values[col_indices],
    )


def mask_grid_to_area(data: Any, lat: Any | None, lon: Any | None, area: dict[str, Any] | None) -> Any:
    if area is None:
        return data
    np = _np()
    values = np.asarray(data, dtype="float64")
    if values.size == 0:
        return values
    if lat is None or lon is None:
        raise ValueError("按分析区域裁剪气象网格需要经纬度坐标。")
    lat_values = np.asarray(lat, dtype="float64")
    lon_values = np.asarray(lon, dtype="float64")
    if lat_values.ndim == 1 and lon_values.ndim == 1:
        if values.shape[-2:] != (lat_values.size, lon_values.size):
            raise ValueError("分析区域裁剪要求网格形状与一维经纬度坐标匹配。")
        lon_grid, lat_grid = np.meshgrid(lon_values, lat_values)
    elif lat_values.ndim == 2 and lon_values.ndim == 2 and lat_values.shape == values.shape and lon_values.shape == values.shape:
        lat_grid, lon_grid = lat_values, lon_values
    else:
        raise ValueError("当前仅支持带一维或二维经纬度坐标的气象网格按分析区域裁剪。")
    geom = area_union(area)
    mask = _shapely().intersects_xy(geom, lon_grid, lat_grid)
    return np.where(mask, values, np.nan)


def require_1d_lat_lon_values(data: Any, lat: Any | None, lon: Any | None) -> tuple[Any, Any]:
    if lat is None or lon is None:
        raise ValueError("该变量没有一维经纬度坐标，无法执行空间裁剪或矢量化。")
    np = _np()
    lat_values = np.asarray(lat, dtype="float64")
    lon_values = np.asarray(lon, dtype="float64")
    if lat_values.ndim != 1 or lon_values.ndim != 1:
        raise ValueError("该变量不是规则经纬网格，当前不支持精确空间裁剪。")
    if not np.isfinite(lat_values).all() or not np.isfinite(lon_values).all():
        raise ValueError("经纬度坐标必须是有限数值。")
    expected = (lat_values.size, lon_values.size)
    if tuple(data.shape[-2:]) != expected:
        raise ValueError("变量网格形状与经纬度坐标长度不一致。")
    return lat_values, lon_values


def coord_edges(values: Any) -> Any:
    np = _np()
    values = np.asarray(values, dtype="float64")
    if values.ndim != 1 or not np.isfinite(values).all():
        raise ValueError("网格坐标必须是一维有限数值。")
    if values.size < 2:
        raise ValueError("单点坐标无法推断网格边界。")
    differences = np.diff(values)
    if not ((differences > 0).all() or (differences < 0).all()):
        raise ValueError("网格坐标必须严格单调，才能推断像元边界。")
    mids = (values[:-1] + values[1:]) / 2
    first = values[0] - (mids[0] - values[0])
    last = values[-1] + (values[-1] - mids[-1])
    return np.concatenate([[first], mids, [last]])


def _find_lat_lon_coords(ds: Any) -> tuple[str | None, str | None]:
    lat = lon = None
    for name, coord in ds.coords.items():
        normalized = str(name).casefold()
        units = str(coord.attrs.get("units", "")).casefold()
        standard_name = str(coord.attrs.get("standard_name", "")).casefold()
        if normalized in {"lat", "latitude"} or "degrees_north" in units or standard_name == "latitude":
            lat = str(name)
        if normalized in {"lon", "longitude"} or "degrees_east" in units or standard_name == "longitude":
            lon = str(name)
    return lat, lon


def _find_time_coord(ds: Any) -> str | None:
    for name, coord in ds.coords.items():
        if _is_time_coord(name, coord):
            return str(name)
    return None


def _find_level_coord(ds: Any) -> str | None:
    for name, coord in ds.coords.items():
        if _is_level_coord(name, coord):
            return str(name)
    return None


def _extract_coord_values(ds: Any, coord_name: str | None, *, limit: int = 72) -> list[str]:
    if not coord_name:
        return []
    values = _np().asarray(ds[coord_name].values).ravel()[:limit]
    unit = _attr_text(ds[coord_name], "units")
    include_unit = bool(unit and coord_name == _find_level_coord(ds))
    return [f"{item} {unit}" if include_unit else str(item) for item in values.tolist()]


def _pick_default_variable(ds: Any, lat_name: str, lon_name: str) -> str:
    for name, data_array in ds.data_vars.items():
        if _is_numeric_dtype(data_array.dtype) and _data_uses_coords(data_array, lat_name, lon_name):
            return str(name)
    raise ValueError("未找到同时包含经纬度坐标的数值变量。")


def _pick_default_numeric_variable(ds: Any) -> str:
    for name, data_array in ds.data_vars.items():
        if not _is_numeric_dtype(data_array.dtype):
            continue
        try:
            _select_2d_data_array(data_array, time_index=0, level_index=0)
        except Exception:
            continue
        return str(name)
    raise ValueError("文件中没有可统计的二维数值型气象变量。")


def _select_2d_data_array(data_array: Any, *, time_index: int | None, level_index: int | None) -> tuple[Any, str | None, str | None]:
    selected = data_array
    time_value: str | None = None
    level_value: str | None = None
    for dim in list(selected.dims):
        if selected.ndim <= 2:
            break
        coord = selected.coords.get(dim)
        is_time = _is_time_coord(dim, coord)
        is_level = _is_level_coord(dim, coord)
        index = int(time_index or 0) if is_time else int(level_index or 0) if is_level else 0
        dimension_size = int(selected.sizes[dim])
        if index < 0 or index >= dimension_size:
            raise ValueError(f"维度 {dim} 的索引 {index} 超出范围 0..{dimension_size - 1}。")
        if coord is not None and is_time:
            time_value = str(_np().asarray(coord.values).ravel()[index])
        if coord is not None and is_level:
            raw_level_value = str(_np().asarray(coord.values).ravel()[index])
            unit = _attr_text(coord, "units")
            level_value = f"{raw_level_value} {unit}" if unit else raw_level_value
        selected = selected.isel({dim: index})
    selected = selected.squeeze(drop=True)
    if selected.ndim != 2:
        raise ValueError(f"变量 {data_array.name} 无法收敛成二维网格。")
    return selected, time_value, level_value


def _transpose_to_lat_lon(selected: Any, ds: Any, lat_name: str | None, lon_name: str | None) -> Any:
    if not lat_name or not lon_name:
        return selected
    lat_dim = _coord_primary_dim(ds[lat_name], lat_name)
    lon_dim = _coord_primary_dim(ds[lon_name], lon_name)
    if lat_dim != lon_dim and lat_dim in selected.dims and lon_dim in selected.dims:
        return selected.transpose(lat_dim, lon_dim)
    return selected


def _thin_selected_data_array_for_render(selected: Any, *, max_size: int) -> Any:
    if selected.ndim != 2:
        return selected
    max_size = max(1, int(max_size or 1024))
    height, width = (int(item) for item in selected.shape[-2:])
    stride = max(1, int(math.ceil(max(height / max_size, width / max_size))))
    if stride <= 1:
        return selected
    row_dim, col_dim = selected.dims[-2], selected.dims[-1]
    return selected.isel({row_dim: slice(None, None, stride), col_dim: slice(None, None, stride)})


def _sample_data_array_stats(data_array: Any) -> list[float] | None:
    try:
        selected, _time_value, _level_value = _select_2d_data_array(data_array, time_index=0, level_index=0)
        selected = _thin_selected_data_array_for_render(selected, max_size=512)
        return finite_range(_normalize_missing_values(_np().asarray(selected.values, dtype="float64"), data_array.attrs))
    except Exception:
        return None


def _data_uses_coords(data_array: Any, lat_name: str, lon_name: str) -> bool:
    dims = set(str(item) for item in data_array.dims)
    return (lat_name in dims and lon_name in dims) or (
        any(str(dim).casefold() in {"lat", "latitude", "y"} for dim in dims)
        and any(str(dim).casefold() in {"lon", "longitude", "x"} for dim in dims)
    )


def _matching_dim_count(data_array: Any, matcher: Any) -> int:
    for dim in data_array.dims:
        coord = data_array.coords.get(dim)
        if matcher(dim, coord):
            return int(data_array.sizes[dim])
    return 0


def _is_time_coord(name: Any, coord: Any | None) -> bool:
    normalized = str(name).casefold()
    attrs = getattr(coord, "attrs", {}) if coord is not None else {}
    return "time" in normalized or str(attrs.get("standard_name", "")).casefold() == "time" or str(attrs.get("axis", "")).casefold() == "t"


def _is_level_coord(name: Any, coord: Any | None) -> bool:
    normalized = str(name).casefold()
    attrs = getattr(coord, "attrs", {}) if coord is not None else {}
    units = str(attrs.get("units", "")).casefold()
    known_names = {"level", "lev", "pressure", "isobaric", "height", "depth", "altitude", "elevation"}
    return (
        normalized in known_names
        or str(attrs.get("axis", "")).casefold() == "z"
        or bool(str(attrs.get("positive", "")).strip())
        or str(attrs.get("standard_name", "")).casefold() in {"air_pressure", "height", "depth", "altitude", "geopotential_height"}
        or units in {"pa", "hpa", "millibar", "mbar"}
    )


def _coord_primary_dim(coord: Any, default_dim: str) -> str:
    return str(coord.dims[0]) if getattr(coord, "dims", None) else default_dim


def bounds_from_coords(lat: Any, lon: Any) -> list[float] | None:
    np = _np()
    lat_values = np.asarray(lat, dtype="float64")
    lon_values = np.asarray(lon, dtype="float64")
    if lat_values.size == 0 or lon_values.size == 0:
        return None
    finite_lat = lat_values[np.isfinite(lat_values)]
    finite_lon = lon_values[np.isfinite(lon_values)]
    if finite_lat.size == 0 or finite_lon.size == 0:
        return None
    if lat_values.ndim == 1 and lon_values.ndim == 1:
        if lat_values.size < 2 or lon_values.size < 2:
            return None
        lat_edges = coord_edges(lat_values)
        lon_edges = coord_edges(lon_values)
        return [float(lon_edges.min()), float(lat_edges.min()), float(lon_edges.max()), float(lat_edges.max())]
    return [float(finite_lon.min()), float(finite_lat.min()), float(finite_lon.max()), float(finite_lat.max())]


def _normalize_missing_values(data: Any, attrs: dict[str, Any]) -> Any:
    np = _np()
    result = np.asarray(data, dtype="float64")
    for key in ("_FillValue", "missing_value"):
        if key not in attrs:
            continue
        raw = attrs.get(key)
        candidates = np.asarray(raw).ravel().tolist() if isinstance(raw, (list, tuple)) else [raw]
        for candidate in candidates:
            try:
                result = np.where(result == float(candidate), np.nan, result)
            except (TypeError, ValueError):
                continue
    return result


def area_union(area: dict[str, Any]) -> Any:
    features = area.get("features") if isinstance(area, dict) else None
    if not isinstance(features, list) or not features:
        raise ValueError("分析区域必须是非空 FeatureCollection。")
    geometries = []
    for feature in features:
        geometry = feature.get("geometry") if isinstance(feature, dict) else None
        if not isinstance(geometry, dict):
            continue
        parsed = _shapely_geometry().shape(geometry)
        if parsed.is_empty:
            continue
        if not parsed.is_valid:
            raise ValueError("分析区域包含无效几何，请先修复几何拓扑。")
        if parsed.geom_type not in {"Polygon", "MultiPolygon"}:
            raise ValueError(f"分析区域只接受 Polygon/MultiPolygon，实际为 {parsed.geom_type}。")
        geometries.append(parsed)
    if not geometries:
        raise ValueError("分析区域没有有效几何。")
    return _shapely_ops().unary_union(geometries)


def _inspect_netcdf_rasterio(path: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any], list[str]]:
    """读取 GDAL 子数据集的地图元数据，不承担科学变量统计。"""
    rasterio = _rasterio()
    try:
        with rasterio.open(path) as src:
            subdatasets = list(src.subdatasets or [])
            root_bounds = _raster_bounds_wgs84(src)
    except rasterio.errors.RasterioIOError as exc:
        return {}, {"available": False, "variables": 0}, [f"Rasterio/GDAL 未能读取 NetCDF 子数据集：{exc}"]

    if not subdatasets:
        return {}, {"available": False, "variables": 0, "subdatasets": []}, []

    by_variable: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    for subdataset in subdatasets:
        variable_name = _subdataset_variable_name(subdataset)
        try:
            with rasterio.open(subdataset) as src:
                bounds = _raster_bounds_wgs84(src)
                by_variable[variable_name.casefold()] = {
                    "subdatasetId": _subdataset_ref_id(subdataset),
                    "variable": variable_name,
                    "mapReady": bounds is not None,
                    "bounds": bounds,
                    "crs": str(src.crs) if src.crs else None,
                    "width": int(src.width),
                    "height": int(src.height),
                    "bandCount": int(src.count),
                    "dataTypes": [str(item) for item in src.dtypes],
                    "tags": {str(key): value for key, value in src.tags().items()},
                }
        except rasterio.errors.RasterioIOError as exc:
            warnings.append(f"Rasterio/GDAL 子数据集 {variable_name} 读取失败：{exc}")
    return (
        by_variable,
        {
            "available": bool(by_variable),
            "variables": len(by_variable),
            "rootBounds": root_bounds,
            "subdatasets": [
                {
                    "variable": item["variable"],
                    "subdatasetId": item["subdatasetId"],
                    "mapReady": item["mapReady"],
                }
                for item in by_variable.values()
            ],
        },
        warnings,
    )


def _select_netcdf_raster_subdataset(path: Path, query: GridQuery) -> str | None:
    """显式判定 NetCDF 是否具备无维度歧义的 Rasterio 渲染能力。"""
    if query.time_index is not None or query.level_index is not None:
        return None
    rasterio = _rasterio()
    try:
        with rasterio.open(path) as root:
            subdatasets = list(root.subdatasets or [])
    except rasterio.errors.RasterioIOError:
        return None
    selected_subdataset = _select_subdataset(subdatasets, query.variable)
    if selected_subdataset is None:
        return None
    with rasterio.open(selected_subdataset) as src:
        return selected_subdataset if src.count == 1 and _raster_bounds_wgs84(src) is not None else None


def _read_netcdf_raster_slice(subdataset: str, query: GridQuery) -> GridSlice:
    """执行已通过能力判定的单波段 NetCDF Rasterio 渲染。"""
    rasterio = _rasterio()
    with rasterio.open(subdataset) as src:
        if src.count != 1:
            raise RuntimeError("已选择的 NetCDF Rasterio 子数据集不再是单波段。")
        data, bounds, lat, lon = _read_raster_band_as_wgs84(
            src,
            band_index=1,
            max_size=query.max_size or 1024,
            resampling=_rasterio_resampling().bilinear,
        )
        if bounds is None:
            raise RuntimeError("已选择的 NetCDF Rasterio 子数据集缺少地理范围。")
        data, lat, lon = crop_grid_with_coords_by_bbox(data, lat, lon, query.bbox)
        data = mask_grid_to_area(data, lat, lon, query.area)
        tags = src.tags(1)
        variable_name = _subdataset_variable_name(subdataset)
        return GridSlice(
            data=data,
            variable=variable_name,
            unit=tags.get("units") or tags.get("unit"),
            long_name=tags.get("long_name") or tags.get("description") or variable_name,
            lat=lat,
            lon=lon,
            bounds=bounds_from_coords(lat, lon) if lat is not None and lon is not None else bounds,
            backend="rasterio",
            mask_applied=query.area is not None,
            metadata={"subdatasetId": _subdataset_ref_id(subdataset)},
        )


def _raster_bounds_wgs84(src: Any) -> list[float] | None:
    if not src.bounds or not src.crs:
        return None
    if str(src.crs).upper() not in {"EPSG:4326", "OGC:CRS84"}:
        west, south, east, north = _rasterio_warp().transform_bounds(src.crs, "EPSG:4326", *src.bounds, densify_pts=21)
    else:
        west, south, east, north = src.bounds
    return [float(west), float(south), float(east), float(north)]


def _raster_band_range(src: Any, band_index: int) -> list[float] | None:
    data = src.read(
        band_index,
        masked=True,
        out_shape=_scaled_shape(src.height, src.width, 512),
        resampling=_rasterio_resampling().nearest,
    )
    values = data.compressed() if hasattr(data, "compressed") else finite_values(data)
    if len(values) == 0:
        return None
    return [float(values.min()), float(values.max())]


def _read_raster_band_as_wgs84(
    src: Any,
    *,
    band_index: int,
    max_size: int,
    resampling: Any,
) -> tuple[Any, list[float] | None, Any | None, Any | None]:
    np = _np()
    max_size = max(1, int(max_size or 1024))
    if src.crs and str(src.crs).upper() not in {"EPSG:4326", "OGC:CRS84"}:
        warp = _rasterio_warp()
        transform_module = _rasterio_transform()
        transform, width, height = warp.calculate_default_transform(
            src.crs,
            "EPSG:4326",
            src.width,
            src.height,
            *src.bounds,
        )
        out_height, out_width = _scaled_shape(height, width, max_size)
        if out_width != width or out_height != height:
            transform = transform * transform.scale(width / out_width, height / out_height)
        destination = np.full((out_height, out_width), np.nan, dtype="float64")
        warp.reproject(
            source=_rasterio().band(src, band_index),
            destination=destination,
            src_transform=src.transform,
            src_crs=src.crs,
            src_nodata=src.nodata,
            dst_transform=transform,
            dst_crs="EPSG:4326",
            dst_nodata=np.nan,
            resampling=resampling,
        )
        west, south, east, north = transform_module.array_bounds(out_height, out_width, transform)
        bounds = [float(west), float(south), float(east), float(north)]
        lat, lon = _raster_coordinate_centers(bounds, out_height, out_width)
        return destination, bounds, lat, lon

    out_shape = _scaled_shape(src.height, src.width, max_size)
    data = src.read(
        band_index,
        out_shape=out_shape,
        masked=True,
        resampling=resampling,
    )
    values = data.filled(np.nan) if hasattr(data, "filled") else np.asarray(data, dtype="float64")
    values = np.asarray(values, dtype="float64")
    if src.nodata is not None:
        values[values == src.nodata] = np.nan
    bounds = _raster_bounds_wgs84(src)
    if bounds is None:
        return values, None, None, None
    lat, lon = _raster_coordinate_centers(bounds, values.shape[0], values.shape[1])
    return values, bounds, lat, lon


def _scaled_shape(height: int, width: int, max_size: int) -> tuple[int, int]:
    scale = max(height / max_size, width / max_size, 1)
    return max(1, int(math.ceil(height / scale))), max(1, int(math.ceil(width / scale)))


def _raster_coordinate_centers(bounds: list[float], height: int, width: int) -> tuple[Any, Any]:
    np = _np()
    west, south, east, north = bounds
    x_resolution = (east - west) / width
    y_resolution = (north - south) / height
    lon = np.linspace(west + x_resolution / 2, east - x_resolution / 2, width)
    lat = np.linspace(north - y_resolution / 2, south + y_resolution / 2, height)
    return lat, lon


def _select_subdataset(subdatasets: list[str], variable: str | None) -> str | None:
    if not subdatasets:
        return None
    if variable is None:
        return subdatasets[0]
    normalized = variable.casefold()
    return next(
        (item for item in subdatasets if _subdataset_variable_name(item).casefold() == normalized),
        None,
    )


def _subdataset_variable_name(subdataset: str) -> str:
    candidate = subdataset.rsplit(":", 1)[-1].strip().strip('"').strip("'")
    if "/" in candidate:
        candidate = candidate.rsplit("/", 1)[-1]
    return candidate or "variable"


def _subdataset_ref_id(subdataset: str) -> str:
    return f"subdataset:{hashlib.sha1(subdataset.encode('utf-8')).hexdigest()[:16]}"


def _band_index_from_variable(variable: str | None, band_count: int) -> int:
    if variable is None:
        return 1
    if not variable.startswith("band_"):
        raise ValueError(f"GeoTIFF 变量名应为 band_N：{variable}")
    try:
        index = int(variable.split("_", 1)[1])
    except ValueError as exc:
        raise ValueError(f"GeoTIFF 变量名应为 band_N：{variable}") from exc
    if index < 1 or index > band_count:
        raise ValueError(f"GeoTIFF 波段超出范围：{variable}")
    return index


def _is_numeric_dtype(dtype: Any) -> bool:
    return _np().issubdtype(dtype, _np().number)


def _attr_text(data_array: Any, key: str) -> str | None:
    value = getattr(data_array, "attrs", {}).get(key)
    return None if value is None else str(value)


def _decode_attr(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return f"bytes:0x{value.hex()}"
    return str(value)


def _first_attr(attrs: Any, *keys: str) -> Any | None:
    for key in keys:
        if key in attrs:
            value = attrs.get(key)
            if value is not None:
                return value
    return None


def _format_label(suffix: str) -> str:
    return {".nc": "NetCDF", ".nc4": "NetCDF", ".grib": "GRIB", ".grib2": "GRIB2", ".grb": "GRIB", ".grb2": "GRIB2", ".h5": "HDF5", ".hdf5": "HDF5"}.get(suffix, suffix.upper().lstrip("."))


def _np() -> Any:
    import numpy as np
    return np


def _xarray() -> Any:
    import xarray as xr
    return xr


def _rasterio() -> Any:
    import rasterio
    return rasterio


def _rasterio_warp() -> Any:
    import rasterio.warp
    return rasterio.warp


def _rasterio_transform() -> Any:
    import rasterio.transform
    return rasterio.transform


def _rasterio_resampling() -> Any:
    from rasterio.enums import Resampling
    return Resampling


def _h5py() -> Any:
    import h5py
    return h5py


def _shapely() -> Any:
    import shapely
    return shapely


def _shapely_geometry() -> Any:
    import shapely.geometry
    return shapely.geometry


def _shapely_ops() -> Any:
    import shapely.ops
    return shapely.ops

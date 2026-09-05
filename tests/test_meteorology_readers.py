# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象 Reader 路由测试
#
#   文件:       test_meteorology_readers.py
#
#   日期:       2026年08月08日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

from __future__ import annotations

from pathlib import Path

import h5py
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_bounds
import xarray as xr

import gis_meteorology.readers as readers_module
from gis_meteorology.radar import DecodedRadar, RadarProduct, radar_product_to_grid
from gis_meteorology.readers import GridQuery, Hdf5ScientificReader
from gis_meteorology.service import MeteorologicalDataService, is_supported_meteorological_file


def test_raw_hdf5_uses_explicit_h5py_reader_without_xarray_fallback(tmp_path: Path) -> None:
    source = tmp_path / "raw.h5"
    with h5py.File(source, "w") as handle:
        rain = handle.create_dataset("products/rain", data=np.array([[1.0, 2.0], [3.0, 4.0]]))
        rain.attrs["units"] = "mm"

    service = MeteorologicalDataService()
    metadata = service.inspect(source)
    stats = service.stats(source, variable="products/rain")

    assert metadata["engine"] == "h5py"
    assert metadata["variables"][0]["name"] == "products/rain"
    assert stats["max"] == 4.0
    with pytest.raises(ValueError, match="没有一维经纬度坐标"):
        service.stats(source, variable="products/rain", bbox=[120.0, 30.0, 121.0, 31.0])


def test_hdf5_reader_pushes_time_and_level_indexes_into_dataset_read(monkeypatch: pytest.MonkeyPatch) -> None:
    reads: list[object] = []

    class FakeDataset:
        shape = (12, 8, 1024, 2048)
        dtype = np.dtype("float32")
        attrs: dict[str, object] = {"units": "mm"}

        def __getitem__(self, key: object) -> np.ndarray:
            reads.append(key)
            return np.full((1024, 2048), 7.0, dtype="float32")

    class FakeFile:
        attrs: dict[str, object] = {}

        def __enter__(self) -> "FakeFile":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def visititems(self, visitor: object) -> None:
            visitor("rain", FakeDataset())  # type: ignore[operator]

    class FakeH5py:
        @staticmethod
        def File(_path: Path, _mode: str) -> FakeFile:
            return FakeFile()

    monkeypatch.setattr(readers_module, "_h5py", lambda: FakeH5py)

    result = Hdf5ScientificReader().read_slice(
        Path("large.h5"),
        GridQuery(variable="rain", time_index=9, level_index=6),
    )

    assert reads == [(9, 6, slice(None), slice(None))]
    assert result.data.shape == (1024, 2048)
    assert result.data[0, 0] == 7.0


def test_netcdf_dimension_index_out_of_range_fails_instead_of_clamping(tmp_path: Path) -> None:
    source = tmp_path / "timed.nc"
    xr.Dataset(
        {"rain": (("time", "lat", "lon"), np.arange(8, dtype="float64").reshape(2, 2, 2))},
        coords={"time": ["2026-08-08T00:00:00", "2026-08-08T01:00:00"], "lat": [30.0, 31.0], "lon": [120.0, 121.0]},
    ).to_netcdf(source, engine="h5netcdf")

    with pytest.raises(ValueError, match="索引 2 超出范围"):
        MeteorologicalDataService().stats(source, variable="rain", time_index=2)


def test_geotiff_band_names_are_strict_and_crs_is_preserved(tmp_path: Path) -> None:
    source = tmp_path / "bands.tif"
    with rasterio.open(
        source,
        "w",
        driver="GTiff",
        height=2,
        width=2,
        count=2,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_bounds(120.0, 30.0, 121.0, 31.0, 2, 2),
    ) as dataset:
        dataset.write(np.array([[1.0, 2.0], [3.0, 4.0]], dtype="float32"), 1)
        dataset.write(np.array([[5.0, 6.0], [7.0, 8.0]], dtype="float32"), 2)

    service = MeteorologicalDataService()
    metadata = service.inspect(source)
    assert metadata["crs"] == "EPSG:4326"
    assert service.stats(source, variable="band_2")["max"] == 8.0
    with pytest.raises(ValueError, match="变量名应为 band_N"):
        service.stats(source, variable="2")
    with pytest.raises(ValueError, match="波段超出范围"):
        service.stats(source, variable="band_3")


def test_grib2_is_a_supported_public_suffix() -> None:
    assert is_supported_meteorological_file("forecast.grib2") is True


def test_radar_radials_are_projected_to_cardinal_cartesian_grid(tmp_path: Path) -> None:
    radial = np.array(
        [
            [0.0, 10.0, 20.0],
            [0.0, 11.0, 21.0],
            [0.0, 12.0, 22.0],
            [0.0, 13.0, 23.0],
        ]
    )
    product = RadarProduct(
        name="reflectivity",
        data=radial[np.newaxis, ...],
        unit="dBZ",
        long_name="反射率因子",
        elevations=[0.5],
    )
    decoded = DecodedRadar(
        path=tmp_path / "radar.bz2",
        latitude=30.0,
        longitude=120.0,
        height_m=10.0,
        radar_type=1,
        range_km=2.0,
        bounds=[119.0, 29.0, 121.0, 31.0],
        products={"reflectivity": product},
    )

    data, lat, lon, _product, selected_index = radar_product_to_grid(
        decoded,
        variable="reflectivity",
        elevation_index=0,
    )

    assert selected_index == 0
    assert data.shape == (5, 5)
    assert lat.ndim == 1 and lon.ndim == 1
    assert data[0, 2] == 20.0  # 北
    assert data[2, 4] == 21.0  # 东
    assert data[4, 2] == 22.0  # 南
    assert data[2, 0] == 23.0  # 西
    assert np.isnan(data[0, 0])

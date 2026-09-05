# +-------------------------------------------------------------------------
#
#   地理智能平台 - xarray 数据集打开边界测试
#
#   文件:       test_xarray_io.py
#
#   日期:       2026年08月08日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import h5py
import numpy as np
import pytest
import xarray as xr

from gis_meteorology.xarray_io import open_xarray_dataset, select_xarray_engine


def test_opens_hdf5_netcdf_with_h5netcdf(tmp_path: Path) -> None:
    source = tmp_path / "rain.nc"
    xr.Dataset({"rain": ("x", np.array([1.0, 2.0]))}).to_netcdf(source, engine="h5netcdf")

    dataset, engine = open_xarray_dataset(xr, source)
    with dataset:
        assert engine == "h5netcdf"
        assert dataset["rain"].values.tolist() == [1.0, 2.0]


def test_opens_classic_netcdf_with_scipy(tmp_path: Path) -> None:
    source = tmp_path / "rain.nc"
    xr.Dataset({"rain": ("x", np.array([1.0, 2.0]))}).to_netcdf(
        source,
        engine="scipy",
        format="NETCDF3_CLASSIC",
    )

    dataset, engine = open_xarray_dataset(xr, source)
    with dataset:
        assert engine == "scipy"
        assert dataset["rain"].values.tolist() == [1.0, 2.0]


def test_detects_hdf5_user_block_signature(tmp_path: Path) -> None:
    source = tmp_path / "with-user-block.nc"
    with h5py.File(source, "w", userblock_size=512) as handle:
        handle.create_dataset("rain", data=np.array([1.0]))

    assert select_xarray_engine(source) == "h5netcdf"


def test_routes_grib_without_trying_other_engines(tmp_path: Path) -> None:
    source = tmp_path / "forecast.grib2"
    source.write_bytes(b"GRIB")
    dataset = SimpleNamespace()
    calls: list[dict[str, object]] = []

    class FakeXarray:
        @staticmethod
        def open_dataset(path: Path, **kwargs: object) -> object:
            calls.append({"path": path, **kwargs})
            return dataset

    opened, engine = open_xarray_dataset(FakeXarray(), source)

    assert opened is dataset
    assert engine == "cfgrib"
    assert calls == [{"path": source, "engine": "cfgrib"}]


def test_rejects_unknown_netcdf_container_before_opening_backend(tmp_path: Path) -> None:
    source = tmp_path / "broken.nc"
    source.write_bytes(b"not-a-scientific-container")

    class BackendMustNotRun:
        @staticmethod
        def open_dataset(_path: Path, **_kwargs: object) -> object:
            raise AssertionError("未识别容器时不应试探后端")

    with pytest.raises(ValueError, match="无法识别气象文件容器签名"):
        open_xarray_dataset(BackendMustNotRun(), source)

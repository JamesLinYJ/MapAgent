# +-------------------------------------------------------------------------
#
#   地理智能平台 - 气象科学链路测试
#
#   文件:       test_meteorology_scientific_chain.py
#
#   日期:       2026年06月08日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

from pathlib import Path
import json
from types import SimpleNamespace

import matplotlib as mpl
import matplotlib.colors as mpl_colors
import numpy as np
import pytest
from pyproj import Geod
import xarray as xr

from gis_meteorology.service import MeteorologicalDataService
from gis_meteorology import NowcastTextService
from gis_meteorology.nowcast import (
    MeteorologicalSequence,
    NowcastAnalysisService,
    NowcastDatasetItem,
    NowcastProductProfile,
    NowcastSequenceService,
    build_analysis_scope,
)
from gis_meteorology.readers import GridSlice
from gis_meteorology.third_party.radar_mosaic_agent import adapter as radar_adapter
from gis_meteorology.third_party.rainfall_risk_map.adapter import render_rainfall_risk_map
from gis_meteorology.third_party.short_term_forecast.adapter import generate_area_rainfall_table
from worker_app.path_sandbox import WorkerPathSandbox
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry
from worker_app.tools import register_builtin_tools


def dispatch_worker_tool(runtime_root: Path, name: str, args: dict[str, object]) -> dict[str, object]:
    registry = WorkerToolRegistry()
    register_builtin_tools(registry)
    return registry.dispatch(name, args, WorkerToolContext(WorkerPathSandbox(runtime_root)))


class _NowcastFrameReader:
    def __init__(self, frames: dict[str, tuple[np.ndarray, str | None]]):
        self.frames = frames
        self.read_count = 0

    def read_slice(self, path: Path, query: object, *, filename: str | None = None) -> GridSlice:
        self.read_count += 1
        data, unit = self.frames[filename or path.name]
        return GridSlice(data=data, variable="QPF", unit=unit)


def _nowcast_sequence(frames: dict[str, tuple[np.ndarray, str | None]]) -> MeteorologicalSequence:
    datasets = [
        NowcastDatasetItem(
            dataset_id=f"frame_{index}",
            filename=filename,
            path=Path(filename),
            metadata={"variables": [{"name": "QPF", "unit": unit}]},
            lead_minutes=(index + 1) * 5,
            sequence_index=index,
        )
        for index, (filename, (_, unit)) in enumerate(frames.items())
    ]
    return MeteorologicalSequence(
        sequence_id="unit_normalization",
        datasets=datasets,
        profile=NowcastProductProfile(),
        variable="QPF",
        bounds=None,
        issue_time=None,
    )


def test_generated_netcdf_inspect_stats_threshold_render_and_report(tmp_path: Path) -> None:
    source = tmp_path / "small.nc"
    dataset = xr.Dataset(
        {"rain": (("time", "lat", "lon"), np.array([[[0.0, 1.0], [2.0, 3.0]]]))},
        coords={"time": ["2026-06-08T00:00:00"], "lat": [30.0, 31.0], "lon": [120.0, 121.0]},
    )
    dataset["rain"].attrs["units"] = "mm"
    dataset.to_netcdf(source, engine="h5netcdf")

    service = MeteorologicalDataService()
    metadata = service.inspect(source)
    stats = service.stats(source, variable="rain", time_index=0)
    threshold = service.threshold_geojson(source, variable="rain", time_index=0, threshold=1.5)
    render = service.render_heatmap(
        source,
        variable="rain",
        time_index=0,
        output_path=tmp_path / "rain.png",
        cog_output_path=tmp_path / "rain.tif",
    )
    report = service.generate_report_docx(
        source,
        output_path=tmp_path / "report.docx",
        llm_interpretation="基于该小型测试数据，降水值由西北向东南递增；本结论仅用于验证报告链路。",
    )

    assert metadata["variables"]
    assert stats["max"] == 3.0
    assert threshold["features"]
    assert render["width"] > 0
    assert report


def test_worker_reads_extensionless_runtime_object_with_original_filename(
    tmp_path: Path,
) -> None:
    # 平台上传文件是内容寻址对象；即便对象路径无扩展名，worker 也必须使用
    # valueRef 中的原始文件名识别科学格式，而不是把 hash 路径判为 unknown。
    source = tmp_path / "objects" / "sha256" / "ab" / ("a" * 64)
    source.parent.mkdir(parents=True, exist_ok=True)
    dataset = xr.Dataset(
        {"QPF": (("lat", "lon"), np.array([[0.0, 1.0], [2.0, 4.0]]))},
        coords={"lat": [30.0, 31.0], "lon": [120.0, 121.0]},
    )
    dataset["QPF"].attrs["units"] = "mm"
    dataset.to_netcdf(source, engine="h5netcdf")

    common = {
        "file_relative_path": source.relative_to(tmp_path).as_posix(),
        "file_name": "202604091955_202604092000.nc",
    }
    metadata = dispatch_worker_tool(tmp_path, "meteorological_inspect", common)
    stats = dispatch_worker_tool(tmp_path, "meteorological_stats", {**common, "variable": "QPF"})
    raster = dispatch_worker_tool(
        tmp_path,
        "meteorological_render",
        {
            **common,
            "variable": "QPF",
            "output_relative_path": "artifacts/qpf.png",
            "output_cog_relative_path": "artifacts/qpf.tif",
        },
    )

    assert metadata["format"] == "NetCDF"
    assert metadata["filename"] == "202604091955_202604092000.nc"
    assert stats["max"] == 4.0
    assert raster["outputRelativePath"] == "artifacts/qpf.png"
    assert raster["outputCogRelativePath"] == "artifacts/qpf.tif"


def test_generated_netcdf_nowcast_reference_chain(tmp_path: Path) -> None:
    files = []
    for index, value in enumerate((1.0, 4.0)):
        valid_minute = (index + 1) * 5
        source = tmp_path / "uploads" / f"202606080000_2026060800{valid_minute:02d}.nc"
        source.parent.mkdir(parents=True, exist_ok=True)
        dataset = xr.Dataset(
            {"rain": (("time", "lat", "lon"), np.array([[[0.0, value], [value, value + 1.0]]]))},
            coords={"time": [f"2026-06-08T0{index}:00:00"], "lat": [30.0, 31.0], "lon": [120.0, 121.0]},
        )
        dataset["rain"].attrs["units"] = "mm"
        dataset.to_netcdf(source, engine="h5netcdf")
        files.append({"fileId": f"file_{index}", "name": source.name, "relativePath": source.relative_to(tmp_path).as_posix()})

    sequence = dispatch_worker_tool(tmp_path, "create_nowcast_sequence", {"files": files, "variable": "rain"})
    inspection = dispatch_worker_tool(tmp_path, "inspect_nowcast_sequence", {"sequence": sequence})
    analysis = dispatch_worker_tool(
        tmp_path,
        "meteorological_precipitation_nowcast",
        {"sequence": sequence},
    )
    answer = dispatch_worker_tool(tmp_path, "answer_nowcast_question", {"analysis": analysis, "question": "未来会下雨吗？"})
    forecast = dispatch_worker_tool(tmp_path, "generate_nowcast_forecast_text", {"analysis": analysis})
    candidate = analysis["mapCandidates"][0]
    raster = dispatch_worker_tool(
        tmp_path,
        "render_nowcast_raster",
        {
            "file_relative_path": candidate["relativePath"],
            "variable": candidate["variable"],
            "output_relative_path": "artifacts/nowcast.png",
            "output_cog_relative_path": "artifacts/nowcast.tif",
        },
    )

    assert inspection["datasetCount"] == 2
    assert analysis["kind"] == "nowcast_precipitation_analysis"
    assert candidate["relativePath"]
    assert answer["answer"]
    assert forecast["answer"]
    assert raster["coordinates"]


def test_nowcast_normalizes_compatible_sequence_units_to_millimeters() -> None:
    frames = {
        "frame_mm.nc": (np.full((2, 2), 3.0), "mm"),
        "frame_mass.nc": (np.full((2, 2), 3.0), "kg m-2"),
        "frame_m.nc": (np.full((2, 2), 0.003), "m"),
    }
    reader = _NowcastFrameReader(frames)
    analysis = NowcastAnalysisService(reader=reader).analyze(_nowcast_sequence(frames))

    timeline = analysis["regions"][0]["timeline"]
    assert analysis["unit"] == "mm"
    assert [frame["sourceUnit"] for frame in timeline] == ["mm", "kg m-2", "m"]
    assert [frame["unit"] for frame in timeline] == ["mm", "mm", "mm"]
    assert [frame["stats"]["p90"] for frame in timeline] == pytest.approx([3.0, 3.0, 3.0])
    assert [frame["rainLevel"] for frame in timeline] == ["moderate", "moderate", "moderate"]
    assert reader.read_count == len(frames)


@pytest.mark.parametrize("unit", [None, "K", "mm h-1"])
def test_nowcast_rejects_missing_or_incompatible_member_units(unit: str | None) -> None:
    frames = {
        "frame_mm.nc": (np.full((2, 2), 3.0), "mm"),
        "frame_invalid.nc": (np.full((2, 2), 3.0), unit),
    }

    with pytest.raises(ValueError, match="缺少单位|降水深度维度不兼容"):
        NowcastAnalysisService(reader=_NowcastFrameReader(frames)).analyze(_nowcast_sequence(frames))


def test_nowcast_sequence_rejects_member_without_selected_precipitation_variable() -> None:
    datasets = [
        {
            "dataset_id": "rain",
            "filename": "202606080000_202606080005.nc",
            "path": Path("rain.nc"),
            "metadata": {"variables": [{"name": "QPF", "unit": "mm"}]},
        },
        {
            "dataset_id": "temperature",
            "filename": "202606080000_202606080010.nc",
            "path": Path("temperature.nc"),
            "metadata": {"variables": [{"name": "TMP", "unit": "K"}]},
        },
    ]

    with pytest.raises(ValueError, match="缺少已选降水变量 QPF"):
        NowcastSequenceService().create_sequence(sequence_id="mixed_variables", datasets=datasets)


def test_nowcast_sequence_rejects_incompatible_declared_member_dimension() -> None:
    datasets = [
        {
            "dataset_id": "rain",
            "filename": "202606080000_202606080005.nc",
            "path": Path("rain.nc"),
            "metadata": {"variables": [{"name": "QPF", "unit": "mm"}]},
        },
        {
            "dataset_id": "temperature_dimension",
            "filename": "202606080000_202606080010.nc",
            "path": Path("temperature_dimension.nc"),
            "metadata": {"variables": [{"name": "QPF", "unit": "K"}]},
        },
    ]

    with pytest.raises(ValueError, match="降水深度维度不兼容"):
        NowcastSequenceService().create_sequence(sequence_id="mixed_dimensions", datasets=datasets)


def test_nowcast_answer_standard_for_citywide_and_location_questions() -> None:
    text = NowcastTextService()
    no_rain = {
        "variable": "QPF",
        "regions": [{"label": "市民中心", "diagnosis": {"hasRain": False}}],
        "movement": {},
        "warnings": [],
    }
    ending = {
        "variable": "QPF",
        "regions": [{
            "label": "市民中心",
            "diagnosis": {
                "hasRain": True,
                "onsetLeadMinutes": 15,
                "peakLeadMinutes": 30,
                "endLeadMinutes": 120,
                "peakLevel": "light",
                "trend": "ending",
            },
        }],
        "movement": {},
        "warnings": [],
    }
    continuous = {
        "variable": "QPF",
        "regions": [{
            "label": "市民中心",
            "diagnosis": {
                "hasRain": True,
                "onsetLeadMinutes": 0,
                "peakLeadMinutes": 0,
                "endLeadMinutes": None,
                "peakLevel": "light",
                "trend": "continuous",
            },
        }],
        "movement": {},
        "warnings": [],
    }
    citywide_rain = {
        "variable": "QPF",
        "regions": [
            {
                "label": "富阳区",
                "diagnosis": {
                    "hasRain": True,
                    "onsetLeadMinutes": 15,
                    "peakLeadMinutes": 30,
                    "peakLevel": "light",
                    "trend": "intensifying",
                },
            },
            {
                "label": "淳安县",
                "diagnosis": {
                    "hasRain": True,
                    "onsetLeadMinutes": 15,
                    "peakLeadMinutes": 45,
                    "peakLevel": "light",
                    "trend": "intensifying",
                },
            },
        ],
        "movement": {},
        "warnings": [],
    }

    assert text.build_draft_answer(facts=no_rain, question="接下来天气怎么样？")["answer"] == "各分析区域在预报时段内未检出达到有效阈值的降雨。"
    assert text.build_draft_answer(facts=no_rain, question="市民中心天气怎么样？")["answer"] == "市民中心在预报时段内未检出达到有效阈值的降雨。"
    assert text.build_draft_answer(facts=ending, question="市民中心天气怎么样？")["answer"] == (
        "15分钟后市民中心开始出现达到有效阈值的降雨，"
        "30分钟后市民中心降雨强度达到峰值，峰值等级为小雨，2个小时后雨量渐停。"
    )
    assert text.build_draft_answer(facts=continuous, question="市民中心天气怎么样？")["answer"] == (
        "当前到未来短时市民中心开始出现达到有效阈值的降雨，"
        "当前到未来短时市民中心降雨强度达到峰值，峰值等级为小雨，"
        "起雨后持续至预报末端，整体雨势变化不大。"
    )
    assert text.build_draft_answer(facts=citywide_rain, question="接下来天气怎么样？")["answer"] == (
        "15分钟后富阳区、淳安县开始出现达到有效阈值的降雨；"
        "30分钟后富阳区降雨强度达到峰值，峰值等级为小雨；"
        "45分钟后淳安县降雨强度达到峰值，峰值等级为小雨；"
        "富阳区、淳安县起雨后雨势持续增强。"
    )


def test_nowcast_scope_exposes_render_bbox_for_map_crop() -> None:
    location = build_analysis_scope(
        area=None,
        bbox=None,
        coordinate={"lat": 30.2462469, "lng": 120.206011, "label": "市民中心"},
        point_buffer_meters=1000,
        district_name_field=None,
    )
    districts = build_analysis_scope(
        area={
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "properties": {"name": "富阳区"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[119.5, 29.5], [120.5, 29.5], [120.5, 30.5], [119.5, 30.5], [119.5, 29.5]]],
                },
            }],
        },
        bbox=None,
        coordinate=None,
        point_buffer_meters=1000,
        district_name_field="name",
    )

    assert len(location["renderBbox"]) == 4
    assert districts["renderBbox"] == [119.5, 29.5, 120.5, 30.5]


@pytest.mark.parametrize("latitude", [0.0, 30.0, 60.0])
def test_nowcast_point_buffer_preserves_metric_radius_across_latitudes(latitude: float) -> None:
    scope = build_analysis_scope(
        area=None,
        bbox=None,
        coordinate={"lat": latitude, "lng": 120.0, "label": "测试点"},
        point_buffer_meters=1000,
        district_name_field=None,
    )
    coordinates = scope["regions"][0]["collection"]["features"][0]["geometry"]["coordinates"][0]
    geod = Geod(ellps="WGS84")
    distances = [geod.inv(120.0, latitude, float(lon), float(lat))[2] for lon, lat in coordinates[:-1]]

    assert scope["pointBufferMeters"] == 1000.0
    assert min(distances) == pytest.approx(1000.0, abs=0.01)
    assert max(distances) == pytest.approx(1000.0, abs=0.01)


@pytest.mark.parametrize("radius", [0, -1, float("nan")])
def test_nowcast_point_buffer_rejects_invalid_metric_radius(radius: float) -> None:
    with pytest.raises(ValueError, match="缓冲半径"):
        build_analysis_scope(
            area=None,
            bbox=None,
            coordinate={"lat": 30.0, "lng": 120.0},
            point_buffer_meters=radius,
            district_name_field=None,
        )


def test_radar_mosaic_adapter_exposes_original_products_and_rejects_unknown_product(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 雷达原始 bz2 格式较重；这里用 fake 原算法模块验证平台 adapter 的边界：
    # 产品枚举来自原模块，artifact 写入由 adapter 接管，未知产品不能被原脚本隐式归一到反射率。
    timestamp = radar_adapter.datetime(2026, 4, 9, 19, 55)
    station_dir = tmp_path / "Z9001"
    station_dir.mkdir()
    radar_file = station_dir / "RADA_CHN_Z9001_VOL_20260409195500_O_DOR_SAD_CAP_FMT.bin.bz2"
    radar_file.write_bytes(b"fixture")

    fake_module = SimpleNamespace()
    fake_module.PRODUCT_CONFIGS = {
        "reflectivity": object(),
        "velocity": object(),
        "spectrum_width": object(),
        "zdr": object(),
        "cc": object(),
        "dp": object(),
        "kdp": object(),
        "snrh": object(),
        "echo_top": object(),
    }
    fake_module.PRODUCT_ALIASES = {"height": "echo_top"}
    fake_module.product_options = lambda: [{"key": key, "label": key, "short_label": key, "unit": ""} for key in fake_module.PRODUCT_CONFIGS]
    fake_module.normalize_product_key = lambda product: fake_module.PRODUCT_ALIASES.get(product, product)
    fake_module.get_product_config = lambda product: SimpleNamespace(key=product, min_display=0.0)
    fake_module.get_radar_colormap = lambda _product: (mpl.colormaps["viridis"], mpl_colors.Normalize(), [])
    fake_module.parse_record = lambda path: SimpleNamespace(station=path.parent.name, timestamp=timestamp, path=path)
    fake_module.group_records_by_station = lambda records: {"Z9001": list(records)}
    fake_module.build_single_group = lambda station_records, _target, _tolerance: SimpleNamespace(
        records=station_records["Z9001"],
        max_delta_sec=0,
    )

    def process_group(_group, output_dir, *_args) -> None:
        (output_dir / "mosaic.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        np.savez(
            output_dir / "mosaic.npz",
            display_ref=np.array([[1.0, 2.0], [3.0, 4.0]]),
            grid_lon=np.array([[120.0, 121.0], [120.0, 121.0]]),
            grid_lat=np.array([[30.0, 30.0], [31.0, 31.0]]),
        )

    fake_module.process_group = process_group
    monkeypatch.setattr(radar_adapter, "_radar_mosaic_module", lambda: fake_module)

    inspection = radar_adapter.inspect_radar_station_collection([radar_file])
    assert "echo_top" in inspection["products"]
    assert inspection["productAliases"] == {"height": "echo_top"}

    result = radar_adapter.render_radar_mosaic(
        paths=[radar_file],
        output_png=tmp_path / "out.png",
        output_npz=tmp_path / "out.npz",
        output_map_png=tmp_path / "out-map.png",
        target_time="202604091955",
        product="height",
    )
    assert result["product"] == "echo_top"
    assert result["bounds"] == [120.0, 30.0, 121.0, 31.0]
    assert result["outputs"]["mapPng"] == "out-map.png"
    assert (tmp_path / "out.png").exists()
    assert (tmp_path / "out.npz").exists()
    assert (tmp_path / "out-map.png").exists()

    with pytest.raises(ValueError, match="不支持的雷达产品"):
        radar_adapter.render_radar_mosaic(
            paths=[radar_file],
            output_png=tmp_path / "bad.png",
            output_npz=tmp_path / "bad.npz",
            target_time="202604091955",
            product="not_a_product",
        )


def test_radar_mosaic_reference_comparison_generates_slider_images(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 对比工具的第三方模块负责 NC 插值和差值图，这里固定输出，验证平台
    # adapter 对 NPZ 输入、参考 NC 引用、双 PNG artifact 和统计 payload 的封装。
    mosaic_npz = tmp_path / "mosaic.npz"
    np.savez(
        mosaic_npz,
        display_ref=np.array([[2.0, 3.0], [4.0, 5.0]]),
        grid_lon=np.array([[120.0, 121.0], [120.0, 121.0]]),
        grid_lat=np.array([[30.0, 30.0], [31.0, 31.0]]),
    )
    reference_dir = tmp_path / "reference"
    reference_dir.mkdir()
    reference_nc = reference_dir / "202604091955.nc"
    reference_nc.write_bytes(b"fixture")

    def run_comparison(**kwargs):
      output_dir = kwargs["output_dir"]
      (output_dir / "comparison_fixture.png").write_bytes(b"\x89PNG\r\n\x1a\n")
      (output_dir / "comparison_fixture_ref.png").write_bytes(b"\x89PNG\r\n\x1a\n")
      return {
          "nc_file": "202604091955.nc",
          "nc_level_height_km": 1.0,
          "stats": {"rmse": 0.5, "mae": 0.25, "correlation": 0.9},
      }

    monkeypatch.setattr(radar_adapter, "_mosaic_comparison_module", lambda: SimpleNamespace(run_comparison=run_comparison))
    result = radar_adapter.compare_radar_mosaic_reference(
        mosaic_npz=mosaic_npz,
        reference_paths=[reference_nc],
        output_png=tmp_path / "comparison.png",
        output_reference_png=tmp_path / "reference.png",
        target_time="202604091955",
    )

    assert result["ncFile"] == "202604091955.nc"
    assert result["stats"]["rmse"] == 0.5
    assert (tmp_path / "comparison.png").stat().st_size > 0
    assert (tmp_path / "reference.png").stat().st_size > 0


def test_third_party_risk_map_and_area_rainfall_outputs_are_real_files(tmp_path: Path) -> None:
    # 短时强降水风险区划图和区域累计面雨量排行表走真实 xarray/geopandas/matplotlib/openpyxl 链路。
    # 测试只生成小 fixture；用户提供的大 NC 样例用于本机验收，不让 CI 依赖个人路径。
    nc_paths = []
    for name, offset in [
        ("202604091955_202604092000.nc", 0.0),
        ("202604092000_202604092005.nc", 1.0),
    ]:
        source = tmp_path / name
        dataset = xr.Dataset(
            {"QPF": (("lat", "lon"), np.array([[0.0 + offset, 1.0 + offset], [2.0 + offset, 4.0 + offset]]))},
            coords={"lat": [30.0, 31.0], "lon": [120.0, 121.0]},
        )
        dataset["QPF"].attrs["units"] = "mm"
        dataset["QPF"].attrs["standard_name"] = "QPF"
        dataset.to_netcdf(source, engine="h5netcdf")
        nc_paths.append(source)

    boundary = tmp_path / "boundary.geojson"
    boundary.write_text(
        """
        {
          "type": "FeatureCollection",
          "features": [
            {
              "type": "Feature",
              "properties": {
                "name": "测试区",
                "center": [120.1, 30.2],
                "parent": { "adcode": 330100 },
                "acroutes": [100000, 330000, 330100]
              },
              "geometry": {
                "type": "Polygon",
                "coordinates": [[[119.5,29.5],[121.5,29.5],[121.5,31.5],[119.5,31.5],[119.5,29.5]]]
              }
            }
          ]
        }
        """,
        encoding="utf-8",
    )

    risk = render_rainfall_risk_map(
        nc_path=nc_paths[0],
        output_png=tmp_path / "risk.png",
        output_geojson=tmp_path / "risk.geojson",
        variable="QPF",
        boundary_path=boundary,
        map_mode="compare",
        aggregation="mean",
        title="测试风险图",
    )
    table = generate_area_rainfall_table(
        nc_paths=nc_paths,
        boundary_path=boundary,
        output_xlsx=tmp_path / "table.xlsx",
        output_png=tmp_path / "table.png",
        top_n=1,
    )
    hashed_paths = []
    for index, source in enumerate(nc_paths):
        hashed = tmp_path / f"sha256_object_{index}.nc"
        hashed.write_bytes(source.read_bytes())
        hashed_paths.append(hashed)
    hashed_table = generate_area_rainfall_table(
        nc_paths=hashed_paths,
        nc_names=[source.name for source in nc_paths],
        boundary_path=boundary,
        output_xlsx=tmp_path / "table_hash.xlsx",
        output_png=tmp_path / "table_hash.png",
        top_n=1,
    )

    assert (tmp_path / "risk.png").stat().st_size > 0
    assert (tmp_path / "risk.geojson").stat().st_size > 0
    risk_geojson = json.loads((tmp_path / "risk.geojson").read_text(encoding="utf-8"))
    assert risk_geojson["features"][0]["properties"]["center"] == [120.1, 30.2]
    assert risk_geojson["features"][0]["properties"]["parent"] == {"adcode": 330100}
    assert risk["regionSummary"]["topRegions"][0]["name"] == "测试区"
    assert risk["outputs"]["geojson"] == "risk.geojson"
    assert (tmp_path / "table.xlsx").stat().st_size > 0
    assert (tmp_path / "table.png").stat().st_size > 0
    assert table["topRows"][0]["region"] == "测试区"
    load_workbook = pytest.importorskip("openpyxl").load_workbook
    workbook = load_workbook(tmp_path / "table.xlsx")
    worksheet = workbook["区域累计面雨量排行表"]
    assert [worksheet.cell(row=4, column=column).value for column in range(1, 6)] == [
        "排行",
        "区县",
        "最大雨量(mm)",
        "面雨量(mm)",
        "覆盖格点数",
    ]
    assert worksheet.cell(row=5, column=3).value == pytest.approx(table["topRows"][0]["maxRainfall"])
    assert worksheet.cell(row=5, column=3).number_format == "0.000###"
    assert worksheet.cell(row=5, column=4).value == pytest.approx(table["topRows"][0]["areaRainfall"])
    assert hashed_table["timeText"].startswith("2026年04月09日19时55分-2026年04月09日20时05分")

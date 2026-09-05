# +-------------------------------------------------------------------------
#
#   地理智能平台 - 短时临近预报（短临）降水分析服务
#
#   文件:       nowcast.py
#
#   日期:       2026年05月27日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

# 模块职责
#
# 将连续短时临近预报（短临） NC 产品转换成可审计的降水事实：序列时次、区域统计、
# 起止雨、增强减弱、移动方向、地图候选和问答 facts。这里不读取 Agent 历史。

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from .readers import GridQuery, MeteorologicalReaderFacade, coord_edges, finite_values


_PRECIPITATION_UNIT_SCALE_TO_MM = {
    "mm": 1.0,
    "millimeter": 1.0,
    "millimeters": 1.0,
    "millimetre": 1.0,
    "millimetres": 1.0,
    "kgm-2": 1.0,
    "kgm^-2": 1.0,
    "kgm**-2": 1.0,
    "kg/m2": 1.0,
    "kg/m^2": 1.0,
    "kg/m**2": 1.0,
    "m": 1000.0,
    "meter": 1000.0,
    "meters": 1000.0,
    "metre": 1000.0,
    "metres": 1000.0,
}


@dataclass(frozen=True)
class NowcastProductProfile:
    # 短时临近预报（短临）产品变量口径。
    #
    # 变量名不写死在 Agent 中；不同产品可替换 profile。
    profile_id: str = "default_qpf_radar"
    precipitation_variables: tuple[str, ...] = ("QPF", "QPF_30", "QPF_06")
    rain_thresholds_mm: dict[str, float] = field(default_factory=lambda: {"none": 0.1, "light": 2.5, "moderate": 8.0, "heavy": 16.0})
    rain_coverage_threshold: float = 0.02
    peak_candidate_limit: int = 12

    def choose_precipitation_variable(self, available: set[str]) -> str:
        by_casefold = {item.casefold(): item for item in available}
        for candidate in self.precipitation_variables:
            if candidate.casefold() in by_casefold:
                return by_casefold[candidate.casefold()]
        raise ValueError(f"短时临近预报（短临）产品缺少可用降水变量；需要任一变量：{', '.join(self.precipitation_variables)}")

@dataclass(frozen=True)
class NowcastDatasetItem:
    dataset_id: str
    filename: str
    path: Path
    metadata: dict[str, Any] = field(default_factory=dict)
    issue_time: datetime | None = None
    valid_time: datetime | None = None
    lead_minutes: int | None = None
    sequence_index: int = 0


@dataclass(frozen=True)
class MeteorologicalSequence:
    sequence_id: str
    datasets: list[NowcastDatasetItem]
    profile: NowcastProductProfile
    variable: str
    bounds: list[float] | None
    issue_time: datetime | None

    def to_payload(self) -> dict[str, Any]:
        return {
            "sequenceId": self.sequence_id,
            "profile": self.profile.profile_id,
            "variable": self.variable,
            "bounds": self.bounds,
            "issueTime": self.issue_time.isoformat() if self.issue_time else None,
            "timeZone": _timezone_label(self.issue_time),
            "datasets": [
                {
                    "datasetId": item.dataset_id,
                    "filename": item.filename,
                    "storagePath": str(item.path),
                    "sequenceIndex": item.sequence_index,
                    "issueTime": item.issue_time.isoformat() if item.issue_time else None,
                    "validTime": item.valid_time.isoformat() if item.valid_time else None,
                    "leadMinutes": item.lead_minutes,
                    "metadata": item.metadata,
                }
                for item in self.datasets
            ],
        }


class NowcastSequenceService:
    def __init__(self, *, reader: MeteorologicalReaderFacade | None = None):
        self.reader = reader or MeteorologicalReaderFacade()

    def create_sequence(
        self,
        *,
        sequence_id: str,
        datasets: list[dict[str, Any]],
        profile: NowcastProductProfile | None = None,
        horizon_minutes: int | None = None,
    ) -> MeteorologicalSequence:
        profile = profile or NowcastProductProfile()
        items = [self._dataset_item(raw, index) for index, raw in enumerate(datasets)]
        if not items:
            raise ValueError("创建短时临近预报序列至少需要一个 NC 数据集。")
        items.sort(key=lambda item: (item.valid_time or datetime.max, item.filename, item.dataset_id))
        if horizon_minutes is not None:
            if horizon_minutes < 5 or horizon_minutes > 360:
                raise ValueError("短时临近预报时效必须在 5 到 360 分钟之间。")
            available_leads = [item.lead_minutes for item in items if item.lead_minutes is not None]
            if len(available_leads) != len(items):
                raise ValueError("按时效创建短时临近预报序列时，每个数据集都必须包含可解析的预报时效。")
            maximum_lead = max(available_leads)
            if maximum_lead < horizon_minutes:
                raise ValueError(
                    f"短时临近预报数据仅覆盖 {maximum_lead} 分钟，不能满足 {horizon_minutes} 分钟时效。"
                )
            items = [item for item in items if item.lead_minutes is not None and item.lead_minutes <= horizon_minutes]
            if not items:
                raise ValueError(f"短时临近预报序列没有 {horizon_minutes} 分钟时效内的数据。")
            covered_lead = max(item.lead_minutes for item in items if item.lead_minutes is not None)
            if covered_lead < horizon_minutes:
                raise ValueError(
                    f"短时临近预报数据在目标范围内仅覆盖 {covered_lead} 分钟，"
                    f"不能满足 {horizon_minutes} 分钟时效。"
                )
        normalized = [self._replace_index(item, index) for index, item in enumerate(items)]
        member_variable_sets = [self._available_variables(item) for item in normalized]
        variable = profile.choose_precipitation_variable(member_variable_sets[0])
        for item, member_variables in zip(normalized, member_variable_sets, strict=True):
            if variable.casefold() not in {name.casefold() for name in member_variables}:
                raise ValueError(
                    f"短时临近预报序列成员 {item.filename} 缺少已选降水变量 {variable}。"
                )
            declared_unit = _declared_variable_unit(item.metadata, variable)
            if declared_unit is not None:
                _precipitation_scale_to_mm(declared_unit, dataset_label=item.filename, variable=variable)
        bounds = normalized[0].metadata.get("bounds") if isinstance(normalized[0].metadata, dict) else None
        issue_time = next((item.issue_time for item in normalized if item.issue_time is not None), None)
        return MeteorologicalSequence(sequence_id=sequence_id, datasets=normalized, profile=profile, variable=variable, bounds=bounds, issue_time=issue_time)

    def inspect_sequence(self, sequence: MeteorologicalSequence) -> dict[str, Any]:
        return {
            "sequenceId": sequence.sequence_id,
            "datasetCount": len(sequence.datasets),
            "variable": sequence.variable,
            "issueTime": sequence.issue_time.isoformat() if sequence.issue_time else None,
            "timeZone": _timezone_label(sequence.issue_time),
            "validTimes": [item.valid_time.isoformat() if item.valid_time else None for item in sequence.datasets],
            "leadMinutes": [item.lead_minutes for item in sequence.datasets],
            "bounds": sequence.bounds,
            "profile": sequence.profile.profile_id,
            "mapReady": bool(sequence.bounds),
            "analysisReady": True,
            "variables": sorted(self._available_variables(sequence.datasets[0])),
        }

    def _dataset_item(self, raw: dict[str, Any], index: int) -> NowcastDatasetItem:
        dataset_id = str(raw.get("dataset_id") or raw.get("datasetId") or "").strip()
        filename = str(raw.get("filename") or Path(str(raw.get("path"))).name).strip()
        path = Path(str(raw.get("path") or raw.get("storagePath")))
        if not dataset_id or not filename or not path:
            raise ValueError("短时临近预报序列数据集缺少 dataset_id、filename 或 path。")
        issue_time, valid_time = parse_nowcast_times(filename, raw.get("metadata") or {})
        lead_minutes = int((valid_time - issue_time).total_seconds() // 60) if issue_time and valid_time else None
        return NowcastDatasetItem(
            dataset_id=dataset_id,
            filename=filename,
            path=path,
            metadata=dict(raw.get("metadata") or {}),
            issue_time=issue_time,
            valid_time=valid_time,
            lead_minutes=lead_minutes,
            sequence_index=index,
        )

    @staticmethod
    def _replace_index(item: NowcastDatasetItem, index: int) -> NowcastDatasetItem:
        return NowcastDatasetItem(
            dataset_id=item.dataset_id,
            filename=item.filename,
            path=item.path,
            metadata=item.metadata,
            issue_time=item.issue_time,
            valid_time=item.valid_time,
            lead_minutes=item.lead_minutes,
            sequence_index=index,
        )

    def _available_variables(self, item: NowcastDatasetItem) -> set[str]:
        metadata_variables = item.metadata.get("variables") if isinstance(item.metadata, dict) else None
        if isinstance(metadata_variables, list) and metadata_variables:
            return {str(variable.get("name")) for variable in metadata_variables if isinstance(variable, dict) and variable.get("name")}
        index = self.reader.inspect(item.path, filename=item.filename)
        return {str(variable["name"]) for variable in index.variables}


class NowcastAnalysisService:
    def __init__(self, *, reader: MeteorologicalReaderFacade | None = None):
        self.reader = reader or MeteorologicalReaderFacade()

    def analyze(
        self,
        sequence: MeteorologicalSequence,
        *,
        area: dict[str, Any] | None = None,
        bbox: list[float] | None = None,
        coordinate: dict[str, Any] | None = None,
        point_buffer_meters: float = 1000,
        district_name_field: str | None = None,
    ) -> dict[str, Any]:
        scope = build_analysis_scope(area=area, bbox=bbox, coordinate=coordinate, point_buffer_meters=point_buffer_meters, district_name_field=district_name_field)
        regions = scope["regions"]
        timelines = {region["id"]: [] for region in regions}
        centroids: list[dict[str, float | int]] = []
        for item in sequence.datasets:
            for region in regions:
                query = GridQuery(variable=sequence.variable, bbox=region.get("bbox") or bbox, area=region.get("collection"), purpose="nowcast")
                grid = self.reader.read_slice(item.path, query, filename=item.filename)
                data_mm = normalize_precipitation_to_mm(
                    grid.data,
                    grid.unit,
                    dataset_label=item.filename,
                    variable=sequence.variable,
                )
                stats = summarize_grid(data_mm, rain_threshold=sequence.profile.rain_thresholds_mm["none"], coverage_threshold=sequence.profile.rain_coverage_threshold)
                timelines[region["id"]].append(
                    {
                        "datasetId": item.dataset_id,
                        "filename": item.filename,
                        "sequenceIndex": item.sequence_index,
                        "validTime": item.valid_time.isoformat() if item.valid_time else None,
                        "leadMinutes": item.lead_minutes,
                        "sourceUnit": str(grid.unit).strip(),
                        "unit": "mm",
                        "stats": stats,
                        "rainLevel": classify_rain_level(stats, sequence.profile),
                    }
                )
                if region["id"] == regions[0]["id"]:
                    centroid = high_value_centroid(data_mm, grid.lat, grid.lon, threshold=max(sequence.profile.rain_thresholds_mm["light"], stats.get("p90") or 0))
                    if centroid:
                        centroids.append({"sequenceIndex": item.sequence_index, **centroid})
        region_summaries = [
            {
                "regionId": region["id"],
                "label": region["label"],
                "timeline": timelines[region["id"]],
                "diagnosis": diagnose_timeline(timelines[region["id"]]),
            }
            for region in regions
        ]
        movement = diagnose_movement(centroids)
        map_candidates = build_nowcast_map_candidates(sequence, region_summaries)
        return {
            "kind": "nowcast_precipitation_analysis",
            "sequenceId": sequence.sequence_id,
            "variable": sequence.variable,
            "unit": "mm",
            "scope": {key: value for key, value in scope.items() if key != "regions"},
            "regions": region_summaries,
            "movement": movement,
            "mapCandidates": map_candidates,
            "warnings": scope.get("warnings", []),
        }


class NowcastTextService:
    def build_draft_answer(self, *, facts: dict[str, Any], question: str) -> dict[str, Any]:
        regions = facts.get("regions") or []
        warnings = list(facts.get("warnings") or [])
        if not regions:
            return {"answer": "当前短时临近预报（短临）分析没有可用区域结果。", "basis": [], "confidence": 0.2, "warnings": warnings}
        target = None if _is_generic_nowcast_question(question) else select_region_for_question(regions, question)
        movement = facts.get("movement") or {}
        # 全市/概括性问题
        if target is None:
            rainy = [r for r in regions if (r.get("diagnosis") or {}).get("hasRain")]
            if not rainy:
                return {
                    "answer": "各分析区域在预报时段内未检出达到有效阈值的降雨。",
                    "basis": [
                        f"分析变量：{facts.get('variable')}",
                        f"分析区域：{len(regions)} 个区县",
                        "诊断：所有区域均未达到有效降雨阈值",
                    ],
                    "confidence": 0.72, "warnings": warnings,
                }
            basis_parts = [f"分析变量：{facts.get('variable')}", f"分析区域：{len(regions)} 个区县"]
            sorted_rainy = sorted(rainy, key=_region_onset_sort_key)
            # 按起雨时间分组，生成带时间转移的叙述
            time_groups: dict[int, list[dict[str, Any]]] = {}
            for r in sorted_rainy:
                onset = (r.get("diagnosis") or {}).get("onsetLeadMinutes")
                bucket = int(onset) // 15 * 15 if onset is not None else 999
                time_groups.setdefault(bucket, []).append(r)
            parts: list[str] = []
            sorted_buckets = sorted(time_groups.keys())
            for bucket in sorted_buckets:
                group = time_groups[bucket]
                labels = "、".join(r.get("label", "?") for r in group)
                onsets = sorted(
                    int(onset)
                    for region in group
                    if (onset := (region.get("diagnosis") or {}).get("onsetLeadMinutes")) is not None
                )
                parts.append(f"{_lead_window_phrase(onsets)}{labels}开始出现达到有效阈值的降雨")
                for region in group:
                    diagnosis = region.get("diagnosis") or {}
                    basis_parts.append(
                        f"{region.get('label', '?')}：起雨 {diagnosis.get('onsetLeadMinutes')} 分钟，"
                        f"峰值 {diagnosis.get('peakLeadMinutes')} 分钟，趋势 {diagnosis.get('trend')}"
                    )
                # 峰值时刻和等级独立于起雨时刻，不能用峰值等级描述刚起雨的强度。
                peak_groups: dict[tuple[int, str], list[str]] = {}
                for region in group:
                    diagnosis = region.get("diagnosis") or {}
                    peak = diagnosis.get("peakLeadMinutes")
                    if peak is not None:
                        peak_level = _rain_level_label(diagnosis.get("peakLevel"))
                        peak_groups.setdefault((int(peak), peak_level), []).append(str(region.get("label") or "?"))
                for (peak, peak_level), peak_labels in sorted(peak_groups.items()):
                    parts.append(
                        f"{_lead_phrase(peak)}{'、'.join(peak_labels)}降雨强度达到峰值，"
                        f"峰值等级为{peak_level}"
                    )

            # 趋势必须绑定具体区县，不能把任一区县的趋势扩大成全域结论。
            trend_groups: dict[str, list[dict[str, Any]]] = {}
            for region in sorted_rainy:
                trend = str((region.get("diagnosis") or {}).get("trend") or "unknown")
                trend_groups.setdefault(trend, []).append(region)
            trend_phrases = {
                "intensifying": "起雨后雨势持续增强",
                "continuous": "起雨后持续至预报末端，整体雨势变化不大",
                "weakening": "起雨后雨势逐步减弱",
            }
            for trend in ("intensifying", "continuous", "weakening"):
                group = trend_groups.get(trend) or []
                if group:
                    labels = "、".join(str(region.get("label") or "?") for region in group)
                    parts.append(f"{labels}{trend_phrases[trend]}")
            ending_groups: dict[int, list[str]] = {}
            for region in trend_groups.get("ending") or []:
                diagnosis = region.get("diagnosis") or {}
                end = diagnosis.get("endLeadMinutes")
                if end is None:
                    parts.append(f"{region.get('label') or '?'}起雨后雨势逐步减弱")
                else:
                    ending_groups.setdefault(int(end), []).append(str(region.get("label") or "?"))
            for end, labels in sorted(ending_groups.items()):
                parts.append(f"{_lead_phrase(end)}{'、'.join(labels)}降雨结束")

            dry = [region for region in regions if not (region.get("diagnosis") or {}).get("hasRain")]
            if dry:
                dry_labels = "、".join(str(region.get("label") or "?") for region in dry)
                parts.append(f"{dry_labels}在预报时段内未检出达到有效阈值的降雨")
            if movement.get("direction"):
                # 找出降雨区移动方向上的目标区域
                direction_district_hint = _lookup_downstream_district(regions, movement)
                if direction_district_hint:
                    parts.append(f"降雨区往{direction_district_hint}移动")
                else:
                    parts.append(f"降雨区整体{movement['direction']}移动")
            return {"answer": "；".join(parts) + "。", "basis": basis_parts, "confidence": 0.78, "warnings": warnings}
        # 单区域/单地点问题
        diagnosis = target.get("diagnosis") or {}
        answer = format_diagnosis_answer(target.get("label") or "当前区域", diagnosis, movement)
        basis = [
            f"分析变量：{facts.get('variable')}",
            f"分析区域：{target.get('label')}",
            f"起雨：{diagnosis.get('onsetLeadMinutes')} 分钟；峰值：{diagnosis.get('peakLeadMinutes')} 分钟；趋势：{diagnosis.get('trend')}",
        ]
        return {"answer": answer, "basis": basis, "confidence": 0.78 if diagnosis.get("hasRain") else 0.72, "warnings": warnings}

def parse_nowcast_times(filename: str, metadata: dict[str, Any]) -> tuple[datetime | None, datetime | None]:
    for issue_key, valid_key in (("issueTime", "validTime"), ("issue_time", "valid_time")):
        if metadata.get(issue_key) and metadata.get(valid_key):
            return _parse_datetime(str(metadata[issue_key])), _parse_datetime(str(metadata[valid_key]))
    match = re.search(r"(\d{12})_(\d{12})", filename)
    if not match:
        return None, None
    return datetime.strptime(match.group(1), "%Y%m%d%H%M"), datetime.strptime(match.group(2), "%Y%m%d%H%M")


def build_analysis_scope(
    *,
    area: dict[str, Any] | None,
    bbox: list[float] | None,
    coordinate: dict[str, Any] | None,
    point_buffer_meters: float,
    district_name_field: str | None,
) -> dict[str, Any]:
    warnings: list[str] = []
    if coordinate is not None:
        geometry_module = _shapely_geometry()
        lat = float(coordinate["lat"])
        lon = float(coordinate["lng"])
        radius_meters = float(point_buffer_meters)
        if not math.isfinite(lat) or not math.isfinite(lon) or not math.isfinite(radius_meters):
            raise ValueError("短时临近预报地点经纬度与缓冲半径必须是有限数值。")
        if not -90 <= lat <= 90 or not -180 <= lon <= 180:
            raise ValueError("短时临近预报地点必须位于有效的 CRS84 经纬度范围内。")
        if radius_meters <= 0:
            raise ValueError("短时临近预报地点缓冲半径必须大于 0 米。")
        polygon = _local_metric_point_buffer(lon, lat, radius_meters)
        label = str(coordinate.get("label") or "地点")
        collection = _single_feature_collection(geometry_module.mapping(polygon), {"name": label, "kind": "point_buffer"})
        return {
            "type": "coordinate_buffer",
            "label": label,
            "pointBufferMeters": radius_meters,
            "renderBbox": _geom_bounds(polygon),
            "regions": [{"id": "point", "label": label, "collection": collection, "bbox": _geom_bounds(polygon)}],
            "warnings": warnings,
        }
    if area is not None:
        geometry_module = _shapely_geometry()
        features = area.get("features") if isinstance(area, dict) else None
        if not isinstance(features, list) or not features:
            raise ValueError("短时临近预报（短临）分析区域必须是非空 FeatureCollection。")
        field = district_name_field or _infer_name_field(features)
        regions = []
        for index, feature in enumerate(features):
            geometry = feature.get("geometry") if isinstance(feature, dict) else None
            if not geometry:
                continue
            props = feature.get("properties") or {}
            label = str(props.get(field) or props.get("name") or props.get("NAME") or f"区域{index + 1}")
            geom = geometry_module.shape(geometry)
            regions.append(
                {
                    "id": f"region_{index}",
                    "label": label,
                    "collection": {"type": "FeatureCollection", "features": [feature]},
                    "bbox": _geom_bounds(geom),
                }
            )
        if not regions:
            raise ValueError("短时临近预报（短临）分析区域没有有效面要素。")
        return {
            "type": "area",
            "label": "分析区域",
            "nameField": field,
            "renderBbox": _union_bounds([region["bbox"] for region in regions]),
            "regions": regions,
            "warnings": warnings,
        }
    if bbox is not None:
        west, south, east, north = [float(item) for item in bbox]
        polygon = {
            "type": "Polygon",
            "coordinates": [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
        }
        collection = _single_feature_collection(polygon, {"name": "bbox 范围", "kind": "bbox"})
        return {
            "type": "bbox",
            "label": "bbox 范围",
            "renderBbox": bbox,
            "regions": [{"id": "bbox", "label": "bbox 范围", "collection": collection, "bbox": bbox}],
            "warnings": warnings,
        }
    warnings.append("未提供区划、地点或 bbox，按产品完整覆盖范围分析。")
    return {"type": "full_extent", "label": "产品覆盖范围", "regions": [{"id": "full", "label": "产品覆盖范围", "collection": None, "bbox": None}], "warnings": warnings}


def summarize_grid(data: Any, *, rain_threshold: float, coverage_threshold: float) -> dict[str, Any]:
    np = _np()
    values = finite_values(data)
    if values.size == 0:
        return {"count": 0, "rainCoverage": 0.0, "min": None, "max": None, "mean": None, "median": None, "p90": None}
    rain_count = int(np.count_nonzero(values >= rain_threshold))
    coverage = rain_count / max(1, int(values.size))
    if coverage < coverage_threshold:
        effective_values = values
    else:
        effective_values = values[values >= rain_threshold] if rain_count else values
    return {
        "count": int(values.size),
        "rainCoverage": float(coverage),
        "min": float(values.min()),
        "max": float(values.max()),
        "mean": float(values.mean()),
        "median": float(np.percentile(effective_values, 50)),
        "p90": float(np.percentile(effective_values, 90)),
    }


def normalize_precipitation_to_mm(
    data: Any,
    unit: str | None,
    *,
    dataset_label: str,
    variable: str,
) -> Any:
    """将单个短临切片统一为毫米，且不修改 reader 返回的原数组。"""
    np = _np()
    scale = _precipitation_scale_to_mm(unit, dataset_label=dataset_label, variable=variable)
    values = np.asanyarray(data, dtype="float64")
    return values if scale == 1.0 else values * scale


def _precipitation_scale_to_mm(
    unit: str | None,
    *,
    dataset_label: str,
    variable: str,
) -> float:
    if unit is None or not str(unit).strip():
        raise ValueError(
            f"短时临近预报降水变量 {variable} 在数据集 {dataset_label} 中缺少单位；"
            "必须明确为 mm、kg m-2 或 m。"
        )
    normalized = str(unit).strip().casefold()
    normalized = (
        normalized.replace("−", "-")
        .replace("⁻", "-")
        .replace("²", "2")
        .replace("·", "")
        .replace("⋅", "")
        .replace("{", "")
        .replace("}", "")
    )
    normalized = re.sub(r"\s+", "", normalized)
    scale = _PRECIPITATION_UNIT_SCALE_TO_MM.get(normalized)
    if scale is not None:
        return scale
    raise ValueError(
        f"短时临近预报降水变量 {variable} 在数据集 {dataset_label} 中的单位 {unit!r} "
        "与降水深度维度不兼容；仅支持 mm、kg m-2 或 m，降水速率需先按时段积分。"
    )


def _declared_variable_unit(metadata: dict[str, Any], variable: str) -> str | None:
    descriptors = metadata.get("variables") if isinstance(metadata, dict) else None
    if not isinstance(descriptors, list):
        return None
    for descriptor in descriptors:
        if not isinstance(descriptor, dict):
            continue
        if str(descriptor.get("name") or "").casefold() != variable.casefold():
            continue
        unit = descriptor.get("unit")
        if unit is None:
            unit = descriptor.get("units")
        return str(unit) if unit is not None else None
    return None


def classify_rain_level(stats: dict[str, Any], profile: NowcastProductProfile) -> str:
    p90 = stats.get("p90")
    coverage = float(stats.get("rainCoverage") or 0)
    if p90 is None or coverage < profile.rain_coverage_threshold or float(p90) < profile.rain_thresholds_mm["none"]:
        return "none"
    value = float(p90)
    if value < profile.rain_thresholds_mm["light"]:
        return "light"
    if value < profile.rain_thresholds_mm["moderate"]:
        return "moderate"
    if value < profile.rain_thresholds_mm["heavy"]:
        return "heavy"
    return "storm"


def diagnose_timeline(timeline: list[dict[str, Any]]) -> dict[str, Any]:
    rainy = [item for item in timeline if item.get("rainLevel") != "none"]
    if not rainy:
        return {"hasRain": False, "trend": "no_rain", "summary": "未来三小时不会下雨", "onsetLeadMinutes": None, "peakLeadMinutes": None, "endLeadMinutes": None}
    values = [(item, float((item.get("stats") or {}).get("p90") or 0)) for item in rainy]
    peak_item, peak_value = max(values, key=lambda pair: pair[1])
    first = rainy[0]
    last = rainy[-1]
    first_value = float((first.get("stats") or {}).get("p90") or 0)
    last_value = float((last.get("stats") or {}).get("p90") or 0)
    trend = "continuous"
    if last_value > first_value * 1.25 and last.get("sequenceIndex") != first.get("sequenceIndex"):
        trend = "intensifying"
    elif last_value < first_value * 0.65:
        trend = "weakening"
    if timeline[-1].get("rainLevel") == "none":
        trend = "ending"
    end = next((item for item in timeline[timeline.index(first) :] if item.get("rainLevel") == "none"), None)
    return {
        "hasRain": True,
        "trend": trend,
        "summary": _trend_label(trend),
        "onsetLeadMinutes": first.get("leadMinutes"),
        "peakLeadMinutes": peak_item.get("leadMinutes"),
        "endLeadMinutes": end.get("leadMinutes") if end else None,
        "peakLevel": peak_item.get("rainLevel"),
        "peakP90": peak_value,
    }


def high_value_centroid(data: Any, lat: Any | None, lon: Any | None, *, threshold: float) -> dict[str, float] | None:
    if lat is None or lon is None:
        return None
    np = _np()
    values = np.asarray(data, dtype="float64")
    lat_values = np.asarray(lat, dtype="float64")
    lon_values = np.asarray(lon, dtype="float64")
    if values.size == 0 or lat_values.ndim != 1 or lon_values.ndim != 1:
        return None
    mask = np.isfinite(values) & (values >= threshold)
    if not mask.any():
        return None
    rows, cols = np.where(mask)
    weights = values[rows, cols]
    total = weights.sum()
    if total <= 0:
        return None
    return {"lat": float((lat_values[rows] * weights).sum() / total), "lng": float((lon_values[cols] * weights).sum() / total)}


def diagnose_movement(centroids: list[dict[str, float | int]]) -> dict[str, Any]:
    if len(centroids) < 2:
        return {"available": False, "direction": None, "distanceKm": None}
    first = centroids[0]
    last = centroids[-1]
    dlat = float(last["lat"]) - float(first["lat"])
    dlng = float(last["lng"]) - float(first["lng"])
    distance_km = math.hypot(dlat * 111.32, dlng * 111.32 * math.cos(math.radians(float(first["lat"]))))
    if distance_km < 0.5:
        return {"available": True, "direction": "基本稳定", "distanceKm": round(distance_km, 2)}
    direction = _direction_label(dlat, dlng)
    return {"available": True, "direction": direction, "distanceKm": round(distance_km, 2), "from": first, "to": last}


def build_nowcast_map_candidates(
    sequence: MeteorologicalSequence,
    region_summaries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    latest = sequence.datasets[-1]
    candidates.append(_map_candidate(sequence, latest, "最新时次"))
    all_steps = [step for region in region_summaries for step in region.get("timeline", [])]
    rainy_steps = [step for step in all_steps if step.get("rainLevel") != "none"]
    if rainy_steps:
        peak = max(rainy_steps, key=lambda item: float((item.get("stats") or {}).get("p90") or 0))
        peak_dataset = sequence.datasets[int(peak["sequenceIndex"])]
        candidates.append(_map_candidate(sequence, peak_dataset, "降雨峰值时次"))
        onset_dataset = sequence.datasets[int(rainy_steps[0]["sequenceIndex"])]
        candidates.append(_map_candidate(sequence, onset_dataset, "起雨时次"))
    seen: set[tuple[str, str]] = set()
    unique = []
    for item in candidates:
        key = (item["datasetId"], item["variable"])
        if key in seen:
            existing = next(candidate for candidate in unique if (candidate["datasetId"], candidate["variable"]) == key)
            reasons = {str(part).strip() for part in str(existing.get("reason") or "").split(" / ") if str(part).strip()}
            reasons.add(str(item.get("reason") or "").strip())
            existing["reason"] = " / ".join(sorted(reasons))
            continue
        seen.add(key)
        unique.append(item)
    return unique[: sequence.profile.peak_candidate_limit]


def select_region_for_question(regions: list[dict[str, Any]], question: str) -> dict[str, Any] | None:
    for region in regions:
        label = str(region.get("label") or "")
        if label and label in question:
            return region
    if len(regions) == 1:
        return regions[0]
    return None


def format_diagnosis_answer(
    label: str,
    diagnosis: dict[str, Any],
    movement: dict[str, Any],
) -> str:
    if not diagnosis.get("hasRain"):
        return f"{label}在预报时段内未检出达到有效阈值的降雨。"
    onset = diagnosis.get("onsetLeadMinutes")
    peak = diagnosis.get("peakLeadMinutes")
    end = diagnosis.get("endLeadMinutes")
    trend = diagnosis.get("trend")
    peak_level = _rain_level_label(diagnosis.get("peakLevel"))
    parts: list[str] = []
    parts.append(f"{_lead_phrase(onset)}{label}开始出现达到有效阈值的降雨")
    # 峰值时次只代表高分位强度的最大值，不等同于起雨强度或区域平均雨势增强。
    if peak is not None:
        parts.append(f"{_lead_phrase(peak)}{label}降雨强度达到峰值，峰值等级为{peak_level}")
    # 趋势与结束
    if trend == "ending" and end is not None:
        parts.append(f"{_lead_phrase(end)}雨量渐停")
    elif trend == "weakening":
        parts.append("起雨后雨势逐步减弱")
    elif trend == "intensifying":
        parts.append("起雨后雨势持续增强")
    elif trend == "continuous":
        parts.append("起雨后持续至预报末端，整体雨势变化不大")
    return "，".join(parts) + "。"


def _map_candidate(sequence: MeteorologicalSequence, dataset: NowcastDatasetItem, reason: str) -> dict[str, Any]:
    label_time = f"{dataset.lead_minutes}分钟" if dataset.lead_minutes is not None else dataset.filename
    return {
        "datasetId": dataset.dataset_id,
        "filename": dataset.filename,
        "sequenceIndex": dataset.sequence_index,
        "validTime": dataset.valid_time.isoformat() if dataset.valid_time else None,
        "leadMinutes": dataset.lead_minutes,
        "variable": sequence.variable,
        "label": f"{label_time} {sequence.variable}",
        "reason": reason,
    }


def _infer_name_field(features: list[dict[str, Any]]) -> str:
    candidates = ("name", "NAME", "Name", "district", "区县", "区县名", "县名", "行政区")
    props_list = [feature.get("properties") or {} for feature in features if isinstance(feature, dict)]
    for candidate in candidates:
        if sum(1 for props in props_list if props.get(candidate)) >= max(1, len(props_list) // 2):
            return candidate
    raise ValueError("区划边界缺少可识别名称字段，请配置 districtNameField。")


def _single_feature_collection(geometry: dict[str, Any], properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": properties, "geometry": geometry}]}


def _local_metric_point_buffer(lon: float, lat: float, radius_meters: float) -> Any:
    """在以目标点为中心的等距方位投影中做米制缓冲，再返回 CRS84。"""
    pyproj = _pyproj()
    geometry_module = _shapely_geometry()
    transform = _shapely_transform()
    crs84 = pyproj.CRS.from_user_input("OGC:CRS84")
    local_crs = pyproj.CRS.from_proj4(
        f"+proj=aeqd +lat_0={lat:.12g} +lon_0={lon:.12g} +datum=WGS84 +units=m +no_defs"
    )
    to_local = pyproj.Transformer.from_crs(crs84, local_crs, always_xy=True)
    to_crs84 = pyproj.Transformer.from_crs(local_crs, crs84, always_xy=True)
    center = transform(to_local.transform, geometry_module.Point(lon, lat))
    return transform(to_crs84.transform, center.buffer(radius_meters, quad_segs=32))


def _geom_bounds(geom: Any) -> list[float]:
    west, south, east, north = geom.bounds
    return [float(west), float(south), float(east), float(north)]


def _union_bounds(bounds_list: list[list[float]]) -> list[float]:
    return [
        min(bounds[0] for bounds in bounds_list),
        min(bounds[1] for bounds in bounds_list),
        max(bounds[2] for bounds in bounds_list),
        max(bounds[3] for bounds in bounds_list),
    ]


def _parse_datetime(value: str) -> datetime | None:
    text = value.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        pass
    for fmt in ("%Y%m%d%H%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _timezone_label(value: datetime | None) -> str | None:
    if value is None or value.tzinfo is None or value.utcoffset() is None:
        return None
    offset_minutes = int(value.utcoffset().total_seconds() // 60)
    if offset_minutes == 0:
        return "UTC"
    sign = "+" if offset_minutes > 0 else "-"
    hours, minutes = divmod(abs(offset_minutes), 60)
    return f"UTC{sign}{hours:02d}:{minutes:02d}"


def _lookup_downstream_district(regions: list[dict[str, Any]], movement: dict[str, Any]) -> str | None:
    direction = movement.get("direction", "")
    if not direction or not regions:
        return None
    labels = [r.get("label", "") for r in regions if r.get("label")]
    for label in labels:
        if label in direction or any(c in direction for c in label if c != "市" and c != "区" and c != "县"):
            return label
    return None


def _trend_label(trend: str) -> str:
    return {"intensifying": "雨势增强", "weakening": "雨势减弱", "ending": "雨势渐停", "continuous": "持续降雨"}.get(trend, "持续降雨")


def _direction_label(dlat: float, dlng: float) -> str:
    north_south = "北" if dlat > 0 else "南" if dlat < 0 else ""
    east_west = "东" if dlng > 0 else "西" if dlng < 0 else ""
    return f"向{east_west}{north_south}" if east_west or north_south else "基本稳定"


def _lead_phrase(minutes: Any) -> str:
    if minutes is None:
        return "未来"
    value = int(minutes)
    if value <= 0:
        return "当前到未来短时"
    if value >= 60 and value % 60 == 0:
        return f"{value // 60}个小时后"
    return f"{value}分钟后"


def _lead_window_phrase(minutes: list[int]) -> str:
    if not minutes:
        return "未来"
    first = min(minutes)
    last = max(minutes)
    if first == last:
        return _lead_phrase(first)
    return f"{first}至{last}分钟后"


def _region_onset_sort_key(region: dict[str, Any]) -> int:
    onset = (region.get("diagnosis") or {}).get("onsetLeadMinutes")
    return int(onset) if onset is not None else 999


def _is_generic_nowcast_question(question: str) -> bool:
    compact = re.sub(r"[？?。！!\s]", "", question)
    exact_questions = {"接下来天气怎么样", "接下来天气如何", "未来天气怎么样"}
    generic_scope_markers = ("全市", "各区县", "各区", "各县", "全部区域", "所有区域", "当前区域", "整体")
    return compact in exact_questions or any(marker in compact for marker in generic_scope_markers)


def _rain_level_label(level: Any) -> str:
    return {"light": "小雨", "moderate": "中雨", "heavy": "大雨", "storm": "强降雨"}.get(str(level), "降雨")


def _np() -> Any:
    import numpy as np
    return np


def _shapely_geometry() -> Any:
    import shapely.geometry
    return shapely.geometry


def _shapely_transform() -> Any:
    from shapely.ops import transform
    return transform


def _pyproj() -> Any:
    import pyproj
    return pyproj

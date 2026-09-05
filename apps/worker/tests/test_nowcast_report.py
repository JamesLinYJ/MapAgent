# +-------------------------------------------------------------------------
#
#   地理智能平台 - 短临自动化报告测试
#
#   文件:       test_nowcast_report.py
#
#   日期:       2026年07月18日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_SRC = REPO_ROOT / "apps" / "worker" / "src"
GIS_SRC = REPO_ROOT / "packages" / "gis-meteorology" / "src"
for source in (WORKER_SRC, GIS_SRC):
    if str(source) not in sys.path:
        sys.path.insert(0, str(source))

from worker_app.path_sandbox import WorkerPathSandbox
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry
from worker_app.tools import register_builtin_tools
from gis_meteorology import NowcastSequenceService, NowcastTextService


class NowcastReportTests(unittest.TestCase):
    def test_sequence_horizon_selects_only_requested_lead_times(self) -> None:
        datasets = [
            {
                "dataset_id": f"dataset_{lead}",
                "filename": f"202604091955_20260409{19 + (55 + lead) // 60:02d}{(55 + lead) % 60:02d}.nc",
                "path": Path(f"lead_{lead}.nc"),
                "metadata": {"variables": [{"name": "QPF"}]},
            }
            for lead in range(5, 181, 5)
        ]

        sequence = NowcastSequenceService().create_sequence(
            sequence_id="sequence_60_minutes",
            datasets=datasets,
            horizon_minutes=60,
        )

        self.assertEqual(len(sequence.datasets), 12)
        self.assertEqual(sequence.datasets[-1].lead_minutes, 60)
        self.assertEqual(sequence.to_payload()["issueTime"], "2026-04-09T19:55:00")
        self.assertEqual(sequence.to_payload()["datasets"][0]["validTime"], "2026-04-09T20:00:00")
        self.assertIsNone(sequence.to_payload()["timeZone"])

        inspection = NowcastSequenceService().inspect_sequence(sequence)
        self.assertEqual(inspection["validTimes"][0], "2026-04-09T20:00:00")
        self.assertIsNone(inspection["timeZone"])

    def test_sequence_horizon_fails_when_data_does_not_cover_requested_duration(self) -> None:
        datasets = [{
            "dataset_id": "dataset_5",
            "filename": "202604091955_202604092000.nc",
            "path": Path("lead_5.nc"),
            "metadata": {"variables": [{"name": "QPF"}]},
        }]

        with self.assertRaisesRegex(ValueError, "仅覆盖 5 分钟"):
            NowcastSequenceService().create_sequence(
                sequence_id="sequence_too_short",
                datasets=datasets,
                horizon_minutes=60,
            )

    def test_sequence_horizon_fails_when_only_later_frame_exceeds_requested_duration(self) -> None:
        datasets = [
            {
                "dataset_id": "dataset_5",
                "filename": "202604091955_202604092000.nc",
                "path": Path("lead_5.nc"),
                "metadata": {"variables": [{"name": "QPF"}]},
            },
            {
                "dataset_id": "dataset_65",
                "filename": "202604091955_202604092100.nc",
                "path": Path("lead_65.nc"),
                "metadata": {"variables": [{"name": "QPF"}]},
            },
        ]

        with self.assertRaisesRegex(ValueError, "目标范围内仅覆盖 5 分钟"):
            NowcastSequenceService().create_sequence(
                sequence_id="sequence_gap_at_horizon",
                datasets=datasets,
                horizon_minutes=60,
            )

    def test_continuous_rain_does_not_claim_that_area_wide_rainfall_increases(self) -> None:
        draft = NowcastTextService().build_draft_answer(
            question="西湖区未来三小时降雨如何？",
            facts={
                "variable": "QPF",
                "warnings": [],
                "movement": {"available": False, "direction": None},
                "regions": [{
                    "regionId": "xihu",
                    "label": "西湖区",
                    "diagnosis": {
                        "hasRain": True,
                        "trend": "continuous",
                        "onsetLeadMinutes": 5,
                        "peakLeadMinutes": 150,
                        "endLeadMinutes": None,
                        "peakLevel": "moderate",
                    },
                }],
            },
        )

        self.assertNotIn("雨量变大", draft["answer"])
        self.assertIn("西湖区降雨强度达到峰值", draft["answer"])
        self.assertIn("峰值等级为中雨", draft["answer"])
        self.assertIn("整体雨势变化不大", draft["answer"])

    def test_generic_answer_scopes_each_trend_and_lists_dry_regions(self) -> None:
        draft = NowcastTextService().build_draft_answer(
            question="杭州各区县未来三小时降雨如何？",
            facts={
                "variable": "QPF",
                "warnings": [],
                "movement": {"available": False, "direction": None},
                "regions": [
                    {
                        "regionId": "shangcheng",
                        "label": "上城区",
                        "diagnosis": {
                            "hasRain": True,
                            "trend": "intensifying",
                            "onsetLeadMinutes": 5,
                            "peakLeadMinutes": 180,
                            "endLeadMinutes": None,
                            "peakLevel": "moderate",
                        },
                    },
                    {
                        "regionId": "tonglu",
                        "label": "桐庐县",
                        "diagnosis": {
                            "hasRain": True,
                            "trend": "continuous",
                            "onsetLeadMinutes": 70,
                            "peakLeadMinutes": 140,
                            "endLeadMinutes": None,
                            "peakLevel": "light",
                        },
                    },
                    {
                        "regionId": "chunan",
                        "label": "淳安县",
                        "diagnosis": {
                            "hasRain": False,
                            "trend": "dry",
                            "onsetLeadMinutes": None,
                            "peakLeadMinutes": None,
                            "endLeadMinutes": None,
                            "peakLevel": "none",
                        },
                    },
                ],
            },
        )

        self.assertNotIn("未来三小时持续降雨且雨势增强", draft["answer"])
        self.assertIn("5分钟后上城区开始出现达到有效阈值的降雨", draft["answer"])
        self.assertIn("上城区起雨后雨势持续增强", draft["answer"])
        self.assertIn("桐庐县起雨后持续至预报末端，整体雨势变化不大", draft["answer"])
        self.assertIn("淳安县在预报时段内未检出达到有效阈值的降雨", draft["answer"])

    def test_dry_answer_does_not_make_outdoor_safety_promise(self) -> None:
        draft = NowcastTextService().build_draft_answer(
            question="杭州各区县未来三小时降雨如何？",
            facts={
                "variable": "QPF",
                "warnings": [],
                "movement": {"available": False, "direction": None},
                "regions": [{
                    "regionId": "xihu",
                    "label": "西湖区",
                    "diagnosis": {"hasRain": False, "trend": "dry"},
                }],
            },
        )

        self.assertNotIn("放心出门", draft["answer"])
        self.assertEqual(draft["answer"], "各分析区域在预报时段内未检出达到有效阈值的降雨。")

    def test_report_uses_persisted_timeline_and_computes_global_peak(self) -> None:
        registry = WorkerToolRegistry()
        register_builtin_tools(registry)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = registry.dispatch(
                "meteorological_nowcast_report",
                _request(),
                WorkerToolContext(WorkerPathSandbox(root)),
            )

            self.assertEqual(result["frameCount"], 2)
            self.assertEqual(result["globalMaxQpf"], 44.798179626464844)
            self.assertEqual(result["globalMaxValidTime"], "2026-04-09T22:25:00")
            report_path = root / "artifacts" / "run_1" / "report.docx"
            self.assertTrue(report_path.is_file())
            with ZipFile(report_path) as archive:
                settings = archive.read("word/settings.xml").decode("utf-8")
                document = archive.read("word/document.xml").decode("utf-8")
            self.assertIn('w:percent="100"', settings)
            self.assertIn("44.798 mm", document)
            self.assertIn("雨带向西北移动约", document)
            self.assertNotIn("雨带向向西北", document)


def _request() -> dict[str, object]:
    return {
        "automation_run_id": "automation_run_1",
        "automation_id": "meteorological_nowcast_monitor",
        "automation_revision": 1,
        "started_at": "2026-04-09T19:55:00+08:00",
        "completed_at": "2026-04-09T22:55:00+08:00",
        "answer": "未来三小时持续降雨。",
        "analysis": {
            "kind": "nowcast_precipitation_analysis",
            "scope": {"type": "full_extent", "label": "产品覆盖范围"},
            "regions": [{
                "label": "产品覆盖范围",
                "regionId": "full",
                "timeline": [
                    _frame(0, 5, "2026-04-09T20:00:00", 34.53546142578125),
                    _frame(29, 150, "2026-04-09T22:25:00", 44.798179626464844),
                ],
                "diagnosis": {
                    "trend": "continuous",
                    "hasRain": True,
                    "peakP90": 5.2869,
                    "summary": "持续降雨",
                    "peakLevel": "moderate",
                    "endLeadMinutes": None,
                    "peakLeadMinutes": 150,
                    "onsetLeadMinutes": 5,
                },
            }],
            "movement": {
                "available": True,
                "direction": "西北",
                "distanceKm": 87.89,
                "from": {"lat": 29.07, "lng": 120.94, "sequenceIndex": 0},
                "to": {"lat": 29.09, "lng": 120.03, "sequenceIndex": 29},
            },
            "variable": "QPF",
            "warnings": ["按产品完整覆盖范围分析。"],
            "sequenceId": "sequence_1",
            "mapCandidates": [],
        },
        "artifacts": [{
            "artifactId": "artifact_map",
            "artifactType": "raster_cog",
            "name": "短临地图",
            "uri": "/api/v1/results/artifact_map/file",
        }],
        "output_relative_path": "artifacts/run_1/report.docx",
    }


def _frame(index: int, lead: int, valid_time: str, maximum: float) -> dict[str, object]:
    return {
        "stats": {
            "min": 0,
            "max": maximum,
            "mean": 0.4,
            "median": 0.9,
            "p90": 5.2,
            "count": 451401,
            "rainCoverage": 0.19,
        },
        "filename": f"frame_{index}.nc",
        "datasetId": f"file_{index}",
        "rainLevel": "moderate",
        "validTime": valid_time,
        "leadMinutes": lead,
        "sequenceIndex": index,
    }


if __name__ == "__main__":
    unittest.main()

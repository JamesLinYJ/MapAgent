# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 短临序列桥接
#
#   文件:       nowcast_bridge.py
#
#   日期:       2026年07月08日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

"""把 Worker 文件引用转换为 gis_meteorology 短临领域对象。"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from worker_app.path_sandbox import WorkerPathSandbox, referenced_filename, sequence_items
from worker_app.request_args import optional_int, optional_text


def create_nowcast_sequence(args: dict[str, Any], sandbox: WorkerPathSandbox) -> Any:
    from gis_meteorology import NowcastProductProfile, NowcastSequenceService
    from gis_meteorology.service import MeteorologicalDataService

    variable = optional_text(args, "variable")
    datasets = []
    inspector = MeteorologicalDataService()
    for index, item in enumerate(sequence_items(args)):
        source = sandbox.referenced_path(item)
        filename = referenced_filename(item, source)
        datasets.append({
            "dataset_id": str(item.get("fileId") or item.get("datasetId") or f"dataset_{index + 1}"),
            "filename": filename,
            "path": source,
            "metadata": inspector.inspect(source, filename=filename),
        })
    profile = NowcastProductProfile(precipitation_variables=(variable,)) if variable else NowcastProductProfile()
    return NowcastSequenceService().create_sequence(
        sequence_id=f"sequence_{uuid4().hex}",
        datasets=datasets,
        profile=profile,
        horizon_minutes=optional_int(args, "horizon_minutes"),
    )


def nowcast_sequence_from_reference(
    args: dict[str, Any],
    sandbox: WorkerPathSandbox,
    *,
    variable_override: str | None = None,
) -> Any:
    from gis_meteorology import NowcastProductProfile, NowcastSequenceService

    raw = args.get("sequence")
    if not isinstance(raw, dict):
        raise ValueError("sequence 必须是对象")
    raw_datasets = raw.get("datasets")
    if not isinstance(raw_datasets, list) or not raw_datasets:
        raise ValueError("sequence.datasets 必须是非空数组")
    datasets = []
    for index, item in enumerate(raw_datasets):
        if not isinstance(item, dict):
            raise ValueError("sequence.datasets 中每一项必须是对象")
        source = sandbox.referenced_path(item)
        datasets.append({
            "dataset_id": str(item.get("datasetId") or f"dataset_{index + 1}"),
            "filename": str(item.get("filename") or source.name),
            "path": source,
            "metadata": item.get("metadata") if isinstance(item.get("metadata"), dict) else {},
        })
    variable = variable_override or optional_text(raw, "variable")
    profile = NowcastProductProfile(precipitation_variables=(variable,)) if variable else NowcastProductProfile()
    return NowcastSequenceService().create_sequence(
        sequence_id=str(raw.get("sequenceId") or f"sequence_{uuid4().hex}"),
        datasets=datasets,
        profile=profile,
    )


def serialize_nowcast_sequence(sequence: Any, sandbox: WorkerPathSandbox) -> dict[str, Any]:
    payload = sequence.to_payload()
    datasets = []
    for item, raw in zip(sequence.datasets, payload.get("datasets", []), strict=True):
        datasets.append({
            **{key: value for key, value in raw.items() if key != "storagePath"},
            "relativePath": sandbox.relative_runtime_path(item.path),
        })
    return {**payload, "datasets": datasets}

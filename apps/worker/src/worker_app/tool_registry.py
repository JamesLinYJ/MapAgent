# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 工具注册表
#
#   文件:       tool_registry.py
#
#   日期:       2026年07月07日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

"""实例化的 Worker 工具注册表。"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Any, Callable

from pydantic import BaseModel

from worker_app.tool_context import WorkerToolContext
from worker_app.tool_contracts import WorkerPayload


WorkerToolHandler = Callable[[dict[str, Any], WorkerToolContext], dict[str, Any]]


@dataclass(frozen=True)
class WorkerToolEntry:
    name: str
    handler: WorkerToolHandler
    request_model: type[BaseModel]
    response_model: type[BaseModel]
    read_only: bool
    destructive: bool
    timeout_seconds: int
    display_surfaces: tuple[str, ...]
    value_ref_outputs: tuple[str, ...]


class WorkerToolRegistry:
    """持有单个 Worker 应用实例的工具契约与执行函数。"""

    def __init__(self) -> None:
        self._entries: dict[str, WorkerToolEntry] = {}

    def register(
        self,
        name: str,
        handler: WorkerToolHandler,
        *,
        request_model: type[BaseModel],
        response_model: type[BaseModel] = WorkerPayload,
        read_only: bool = True,
        destructive: bool = False,
        timeout_seconds: int = 300,
        display_surfaces: tuple[str, ...] = (),
        value_ref_outputs: tuple[str, ...] = (),
    ) -> None:
        if name in self._entries:
            raise ValueError(f"工具 '{name}' 重复注册——每个工具名只能注册一次")
        self._entries[name] = WorkerToolEntry(
            name=name,
            handler=handler,
            request_model=request_model,
            response_model=response_model,
            read_only=read_only,
            destructive=destructive,
            timeout_seconds=timeout_seconds,
            display_surfaces=display_surfaces,
            value_ref_outputs=value_ref_outputs,
        )

    def dispatch(self, name: str, args: dict[str, Any], context: WorkerToolContext) -> dict[str, Any]:
        entry = self._entries.get(name)
        if entry is None:
            raise ValueError(f"未知科学计算工具：{name}")
        request = entry.request_model.model_validate(args)
        payload = entry.handler(request.model_dump(exclude_none=True), context)
        entry.response_model.model_validate(payload)
        return payload

    def list_tools(self) -> list[str]:
        return sorted(self._entries)

    def catalog(self) -> dict[str, Any]:
        specs = []
        for name in self.list_tools():
            entry = self._entries[name]
            contract = _entry_contract(entry)
            specs.append({
                "toolName": name,
                "route": f"/tools/{name}",
                "contract": contract,
                "schemaHash": _contract_hash(contract),
            })
        return {"tools": specs, "count": len(specs)}


def _entry_contract(entry: WorkerToolEntry) -> dict[str, Any]:
    return {
        "providerId": "geo-platform-meteorology-worker",
        "toolName": entry.name,
        "version": "0.1.0",
        "parametersSchema": entry.request_model.model_json_schema(),
        "resultSchema": entry.response_model.model_json_schema(),
        "valueRefInputs": [],
        "valueRefOutputs": list(entry.value_ref_outputs),
        "readOnly": entry.read_only,
        "destructive": entry.destructive,
        "timeoutSeconds": entry.timeout_seconds,
        "displaySurfaces": list(entry.display_surfaces),
    }


def _contract_hash(contract: dict[str, Any]) -> str:
    encoded = json.dumps(contract, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()

# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 工具注册表测试
#
#   文件:       test_worker_registry.py
#
#   日期:       2026年07月13日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""Worker registry、上下文注入和认证目标单元测试。"""

from __future__ import annotations

import ast
import sys
import tempfile
import unittest
from pathlib import Path

from pydantic import BaseModel

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_SRC = REPO_ROOT / "apps" / "worker" / "src"
GIS_SRC = REPO_ROOT / "packages" / "gis-meteorology" / "src"
if str(WORKER_SRC) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC))

from worker_app.path_sandbox import WorkerPathSandbox
from worker_app.security_middleware import worker_auth_target
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry
from worker_app.tools import register_builtin_tools


class EchoRequest(BaseModel):
    value: str


class WorkerRegistryTests(unittest.TestCase):
    def test_builtin_catalog_is_complete_and_isolated(self) -> None:
        first = WorkerToolRegistry()
        second = WorkerToolRegistry()
        register_builtin_tools(first)
        register_builtin_tools(second)

        self.assertEqual(first.catalog()["count"], 19)
        self.assertEqual(first.list_tools(), second.list_tools())
        self.assertIn("meteorological_inspect", first.list_tools())
        self.assertIn("render_radar_mosaic", first.list_tools())

    def test_dispatch_receives_injected_runtime_root(self) -> None:
        registry = WorkerToolRegistry()

        def echo(args, context):
            return {"value": args["value"], "root": str(context.path_sandbox.runtime_root)}

        registry.register("echo", echo, request_model=EchoRequest)
        with tempfile.TemporaryDirectory() as directory:
            context = WorkerToolContext(WorkerPathSandbox(Path(directory)))
            result = registry.dispatch("echo", {"value": "ok"}, context)

        self.assertEqual(result["value"], "ok")
        self.assertEqual(Path(result["root"]), Path(directory).resolve())

    def test_catalog_uses_the_signed_catalog_target(self) -> None:
        self.assertEqual(worker_auth_target("/tools/catalog"), "catalog")
        self.assertEqual(worker_auth_target("/tools/meteorological_stats"), "meteorological_stats")

    def test_production_import_graph_uses_the_adapter_not_the_legacy_flask_app(self) -> None:
        adapter_module = "gis_meteorology.third_party.short_term_forecast.adapter"
        legacy_prefix = "gis_meteorology.third_party.short_term_forecast.source"
        imported_modules: set[str] = set()

        for root in (WORKER_SRC, GIS_SRC):
            for python_file in root.rglob("*.py"):
                relative_parts = python_file.relative_to(root).parts
                if "source" in relative_parts:
                    continue
                tree = ast.parse(python_file.read_text(encoding="utf-8"), filename=str(python_file))
                for node in ast.walk(tree):
                    if isinstance(node, ast.ImportFrom) and node.module:
                        imported_modules.add(node.module)
                    elif isinstance(node, ast.Import):
                        imported_modules.update(alias.name for alias in node.names)

        self.assertIn(adapter_module, imported_modules)
        self.assertFalse(any(name.startswith(legacy_prefix) for name in imported_modules))


if __name__ == "__main__":
    unittest.main()

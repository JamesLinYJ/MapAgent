# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 工具日志测试
#
#   文件:       test_worker_tool_logging.py
#
#   日期:       2026年08月03日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

"""验证一次 Worker 工具调用只产生一条有界业务事件。"""

from __future__ import annotations

import logging
import sys
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_SRC = REPO_ROOT / "apps" / "worker" / "src"
if str(WORKER_SRC) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC))

from worker_app.execution import InProcessToolExecutor
from worker_app.logging import WorkerJsonFormatter
from worker_app.path_sandbox import WorkerPathSandbox
from worker_app.tool_context import WorkerToolContext
from worker_app.tool_registry import WorkerToolRegistry
from worker_app.tool_routes import register_tool_routes


class EchoRequest(BaseModel):
    value: str


class ListHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


class WorkerToolLoggingTests(unittest.TestCase):
    def test_successful_tool_call_emits_one_summary_without_arguments(self) -> None:
        registry = WorkerToolRegistry()
        registry.register(
            "echo",
            lambda args, _context: {"value": args["value"]},
            request_model=EchoRequest,
        )
        handler = ListHandler()
        logger = logging.Logger("worker.test", logging.INFO)
        logger.addHandler(handler)
        logger.propagate = False
        app = FastAPI()

        with tempfile.TemporaryDirectory() as directory:
            register_tool_routes(
                app,
                tool_timeout_seconds=5,
                logger=logger,
                tool_context=WorkerToolContext(WorkerPathSandbox(Path(directory))),
                tool_executor=InProcessToolExecutor(registry),
            )
            response = TestClient(app).post(
                "/tools/echo",
                json={"args": {"value": "用户工具参数不得写入日志"}},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(handler.records), 1)
        record = handler.records[0]
        self.assertEqual(record.event, "tool.worker.completed")
        self.assertEqual(record.tool_name, "echo")
        encoded = WorkerJsonFormatter().format(record)
        self.assertNotIn("用户工具参数", encoded)
        self.assertNotIn('"args"', encoded)


if __name__ == "__main__":
    unittest.main()

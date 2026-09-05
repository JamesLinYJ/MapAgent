# +-------------------------------------------------------------------------
#
#   地理智能平台 - Python 科学计算 Worker 入口
#
#   文件:       sidecar.py
#
#   日期:       2026年06月23日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

"""平台 Python 科学计算 Worker 进程入口。"""

from pathlib import Path

from worker_app.app_factory import create_worker_app
from worker_app.bootstrap import configure_science_package_path
from worker_app.logging import configure_logging
from worker_app.settings import WorkerSettings


configure_logging()
configure_science_package_path(Path(__file__))
app = create_worker_app(WorkerSettings.from_env())

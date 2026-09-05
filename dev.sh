#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   地理智能平台 - Bash 开发入口
#
#   文件:       dev.sh
#
#   日期:       2026年04月14日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

# 平台的跨系统开发语义由 TypeScript 启动器统一拥有；本文件只保留 Bash 进程入口。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
exec npm run dev --workspace @geo-agent-platform/operations-supervisor -- "$@"

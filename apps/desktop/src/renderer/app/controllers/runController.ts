// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行控制器
//
//   文件:       runController.ts
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import {
cancelRun,respondDecision,
steerRun,
startAnalysis,
startThreadRun
} from '../../api/client'
import { useRunState } from '../../features/runs/useRunState'

// 运行控制器是 AppShell 与运行态之间的薄边界。
//
// 实时快照由 useRunState 维护；写命令仍走统一 WebSocket API 客户端。
export function useRunController() {
  return {
    ...useRunState(),
    cancelRun,
    respondDecision,
    steerRun,
    startAnalysis,
    startThreadRun,
  }
}

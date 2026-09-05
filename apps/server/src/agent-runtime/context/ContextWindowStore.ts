// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久上下文窗口存储端口
//
//   文件:       ContextWindowStore.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  ContextWindow,
  ContextWindowCompaction,
  ContextWindowSourceSummary,
} from '@geo-agent-platform/shared-types/context-window'

export interface EnsureContextWindowInput {
  runId: string
  promptProtocolVersion: string
  sourceSummary: ContextWindowSourceSummary
  sourceDigest: string
}

export interface RolloverContextWindowInput extends EnsureContextWindowInput {
  expectedContextWindowId: string
  reason: 'compaction' | 'hard_limit' | 'manual'
  compaction: ContextWindowCompaction
}

/**
 * 同一运行只允许一个活动窗口。普通模型请求复用它；只有显式压缩或换窗
 * 才能关闭旧窗口并创建下一代。
 */
export interface ContextWindowStore {
  ensureActive(input: EnsureContextWindowInput): Promise<ContextWindow>
  getActive(runId: string): Promise<ContextWindow | null>
  rollover(input: RolloverContextWindowInput): Promise<ContextWindow>
}

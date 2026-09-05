// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent Run API
//
//   文件:       runApi.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  type AgentExecutionMode,
  type AgentRunProfile,
  type AnalysisRun,
  type RunGoalInput,
  type RunAttachmentInput,
  type RunSnapshot,
  type RunSteeringRecord,
} from '@geo-agent-platform/shared-types'

import { requestControl } from './transport'

export function startAnalysis(
  sessionId: string,
  query: string,
  provider?: string,
  model?: string,
  executionMode: AgentExecutionMode = 'auto',
  runProfile: AgentRunProfile = 'standard',
  goal: RunGoalInput | null = null,
  attachments: RunAttachmentInput[] = [],
): Promise<AnalysisRun> {
  return requestControl('run:start', {
    sessionId,
    query,
    provider,
    modelName: model,
    executionMode,
    runProfile,
    goal,
    attachments,
  })
}

export function startThreadRun(
  threadId: string,
  query: string,
  provider?: string,
  model?: string,
  executionMode: AgentExecutionMode = 'auto',
  runProfile: AgentRunProfile = 'standard',
  goal: RunGoalInput | null = null,
  attachments: RunAttachmentInput[] = [],
): Promise<AnalysisRun> {
  return requestControl('run:start', {
    threadId,
    query,
    provider,
    modelName: model,
    executionMode,
    runProfile,
    goal,
    attachments,
  })
}

export function respondDecision(
  runId: string,
  decisionId: string,
  optionId?: string | null,
  text?: string | null,
): Promise<AnalysisRun> {
  return requestControl('run:respond-decision', { runId, decisionId, optionId, text })
}

export function cancelRun(runId: string): Promise<AnalysisRun> {
  return requestControl('run:cancel', { runId })
}

export function steerRun(runId: string, content: string, steeringId: string): Promise<RunSteeringRecord> {
  return requestControl('run:steer', { runId, content, steeringId })
}

export function subscribeRun(runId: string): Promise<RunSnapshot> {
  return requestControl('run:subscribe', { runId })
}

export function unsubscribeRun(runId: string) {
  return requestControl('run:unsubscribe', { runId })
}

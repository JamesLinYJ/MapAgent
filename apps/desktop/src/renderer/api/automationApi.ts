// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 传输边界
//
//   文件:       automationApi.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 Automation Studio、运行、审批、定时任务和后台任务传输边界。

import {
type BackgroundTaskInfo,
type ScheduledTask,
type AutomationDefinition,
type AutomationGraph,
type AutomationRunRecord,
type AutomationValidationResult,type WsCommandResponse
} from '@geo-agent-platform/shared-types'
import { requestControl } from './transport'

export interface AutomationDraftPayload {
  automationId?: string
  name: string
  description: string
  version: string
  parametersSchema: Record<string, unknown>
  defaultParameters: Record<string, unknown>
  timeoutSeconds: number
  outputType: string
  graph: AutomationGraph
}

export interface AutomationUpdatePayload extends AutomationDraftPayload {
  automationId: string
  expectedRevision: number
}

export interface StartAutomationPayload {
  automationId: string
  prompt: string
  parameters?: Record<string, unknown>
}

export interface ScheduledTaskCreatePayload {
  targetKind: 'automation'
  targetId: string
  title?: string | null
  prompt: string
  parameters?: Record<string, unknown>
  cron: string
  timezone: string
  recurring?: boolean
  enabled?: boolean
}

export interface ScheduledTaskUpdatePayload extends Partial<ScheduledTaskCreatePayload> {
  taskId: string
}

export function listAutomations(): Promise<{
  definitions: AutomationDefinition[]
  diagnostics: Array<Record<string, unknown>>
  validation: Record<string, AutomationValidationResult>
}> {
  return requestControl('automation:list')
}

export function validateAutomation(payload: AutomationDraftPayload): Promise<AutomationValidationResult> {
  return requestControl('automation:validate', { ...payload })
}

export function createAutomation(payload: AutomationDraftPayload): Promise<AutomationDefinition> {
  return requestControl('automation:create', { ...payload })
}

export function updateAutomation(payload: AutomationUpdatePayload): Promise<AutomationDefinition> {
  return requestControl('automation:update', { ...payload })
}

export function publishAutomation(automationId: string, revision: number): Promise<AutomationDefinition> {
  return requestControl('automation:publish', { automationId, revision })
}

export function disableAutomation(automationId: string): Promise<AutomationDefinition> {
  return requestControl('automation:disable', { automationId })
}

export function startAutomation(payload: StartAutomationPayload): Promise<WsCommandResponse<'automation:start'>> {
  return requestControl('automation:start', { ...payload })
}

export function cancelAutomation(automationRunId: string): Promise<AutomationRunRecord> {
  return requestControl('automation:cancel', { automationRunId })
}

export function respondAutomationApproval(
  automationRunId: string,
  approvalId: string,
  decision: 'approved' | 'rejected',
): Promise<WsCommandResponse<'automation:respond-approval'>> {
  return requestControl('automation:respond-approval', { automationRunId, approvalId, decision })
}

export function listScheduledTasks(): Promise<{ tasks: ScheduledTask[]; automationRuns: AutomationRunRecord[] }> {
  return requestControl('scheduled-task:list')
}

export function createScheduledTask(payload: ScheduledTaskCreatePayload): Promise<ScheduledTask> {
  return requestControl('scheduled-task:create', { ...payload })
}

export function updateScheduledTask(payload: ScheduledTaskUpdatePayload): Promise<ScheduledTask> {
  return requestControl('scheduled-task:update', { ...payload })
}

export function deleteScheduledTask(taskId: string): Promise<ScheduledTask> {
  return requestControl('scheduled-task:delete', { taskId })
}

export function listBackgroundTasks(): Promise<{ tasks: BackgroundTaskInfo[] }> {
  return requestControl('background-task:list')
}

export function promoteBackgroundTask(taskId: string): Promise<BackgroundTaskInfo> {
  return requestControl('background-task:promote', { taskId })
}

export function cancelBackgroundTask(taskId: string): Promise<BackgroundTaskInfo> {
  return requestControl('background-task:cancel', { taskId })
}

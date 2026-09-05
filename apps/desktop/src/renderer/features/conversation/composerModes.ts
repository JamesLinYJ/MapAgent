// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话输入模式
//
//   文件:       composerModes.ts
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { ComposerMode } from './types'
import type { AgentExecutionMode, AgentRunProfile } from '@geo-agent-platform/shared-types'

export interface ComposerModeOption {
  id: ComposerMode | 'bypass'
  label: string
  shortLabel: string
  description: string
  badge: string
  executionMode: AgentExecutionMode | null
  runProfile: AgentRunProfile
  disabled?: boolean
  disabledReason?: string
}

export const COMPOSER_MODES = [
  {
    id: 'approval',
    label: '手动审批模式',
    shortLabel: '审批',
    description: '按服务端权限策略执行，写入、导出、删除和高风险工具会先请求确认。',
    badge: '策略审批 · 风险动作确认',
    executionMode: 'auto',
    runProfile: 'standard',
  },
  {
    id: 'auto',
    label: '自动模式',
    shortLabel: '自动',
    description: '自动规划、调用工具并推进结果。',
    badge: '安全工具自动推进',
    executionMode: 'auto',
    runProfile: 'standard',
  },
  {
    id: 'plan',
    label: '计划模式',
    shortLabel: '计划',
    description: '先生成执行计划，确认后再继续。',
    badge: '先审阅 · 后执行',
    executionMode: 'plan',
    runProfile: 'standard',
  },
  {
    id: 'compose',
    label: '地理分析 Compose',
    shortLabel: 'Compose',
    description: '按数据发现、质量核验、分析、验证和交付阶段持续执行到可核验结果。',
    badge: '阶段化交付 · 独立验证',
    executionMode: 'auto',
    runProfile: 'geospatial_compose',
  },
  {
    id: 'bypass',
    label: '免审批权限',
    shortLabel: '免审',
    description: '前端不能直接跳过审批；需要管理员策略和服务端授权后才可启用。',
    badge: '管理员策略控制',
    executionMode: null,
    runProfile: 'standard',
    disabled: true,
    disabledReason: '当前工作区未授予免审批策略。',
  },
] as const satisfies readonly ComposerModeOption[]

export function composerModeOption(mode: ComposerMode): ComposerModeOption {
  const option = COMPOSER_MODES.find(item => item.id === mode)
  if (!option) throw new Error(`未注册执行方式：${mode}`)
  return option
}

export function isSelectableComposerMode(id: ComposerModeOption['id']): id is ComposerMode {
  return id === 'approval' || id === 'auto' || id === 'plan' || id === 'compose'
}

export function runProfileForComposerMode(mode: ComposerMode): AgentRunProfile {
  return composerModeOption(mode).runProfile
}

export function executionModeForComposerMode(mode: ComposerMode): AgentExecutionMode {
  const executionMode = composerModeOption(mode).executionMode
  if (!executionMode) throw new Error(`执行方式 ${mode} 没有运行时映射。`)
  return executionMode
}

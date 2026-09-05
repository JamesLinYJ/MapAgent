// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 审批决策
//
//   文件:       runtimeApprovals.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 将 SDK approval interruption 转为统一 DecisionRequest。运行时负责
// 发现中断和落盘，本文件只定义审批文案、选项和决策状态合并规则。

import type { DecisionRequest } from '../schemas/types.js'
import { nowUtc } from '../utils/ids.js'

export function approvalTitle(toolName: string, label?: string): string {
  return `批准执行：${label ?? toolName}`
}

export function approvalDescription(toolName: string, description?: string): string {
  return description ?? `工具 ${toolName} 需要审批`
}

export function approvalRejectionMessage(_toolName: string): string {
  return '用户拒绝执行该工具。不要重试同一个动作；没有拒绝原因时请请求澄清。'
}

export function approvalDecisionFromRequest(request: {
  approvalId: string
  action: string
  title: string
  description: string
  status: string
  payload: Record<string, unknown>
  createdAt: string
  resolvedAt: string | null
}): DecisionRequest {
  return {
    decisionId: request.approvalId,
    kind: 'approval',
    title: request.title,
    question: request.title,
    description: request.description,
    options: [
      {
        optionId: 'approve',
        label: '批准执行',
        description: '只允许当前这一次精确调用。',
        kind: 'approval',
        reason: null,
        payload: { approved: true, scope: 'exact_call' },
      },
      {
        optionId: 'approve_session',
        label: '本次会话均允许',
        description: '同一会话内，相同工具、资源和权限范围不再重复询问。',
        kind: 'approval',
        reason: null,
        payload: { approved: true, scope: 'session' },
      },
      {
        optionId: 'reject',
        label: '拒绝',
        description: '拒绝本次动作，运行会按拒绝结果继续。',
        kind: 'approval',
        reason: null,
        payload: {
          approved: false,
          scope: 'exact_call',
          reason: '用户拒绝执行该工具。',
        },
      },
    ],
    allowFreeText: false,
    status: request.status,
    payload: {
      ...request.payload,
      approvalId: request.approvalId,
      action: request.action,
    },
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt,
  }
}

export function upsertDecision(decisions: DecisionRequest[], decision: DecisionRequest): DecisionRequest[] {
  return [...decisions.filter(item => item.decisionId !== decision.decisionId), decision]
}

export function resolveDecision(
  decisions: DecisionRequest[],
  decisionId: string,
  status: string,
  payload: Record<string, unknown>,
): DecisionRequest[] {
  const resolvedAt = nowUtc()
  return decisions.map(decision => decision.decisionId === decisionId
    ? { ...decision, status, resolvedAt, payload: { ...decision.payload, ...payload } }
    : decision)
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 审批策略引擎
//
//   文件:       ApprovalPolicyEngine.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ApprovalAction } from '@geo-agent-platform/shared-types/approval-runtime'
import type { AgentStepContext } from '@geo-agent-platform/shared-types/agent-step-context'
import type { AgentToolDescriptorSource } from '@geo-agent-platform/shared-types/tool-runtime'

import { resolveToolPermission } from '../tools/ToolPolicy.js'

export type ApprovalPolicyOutcome =
  | { kind: 'forbidden'; reason: string }
  | { kind: 'allowed'; approvalDecision: 'not_required' }
  | { kind: 'approval_required'; action: ApprovalAction; reason: string }

/**
 * PolicyEngine 只解释不可变 StepContext，不读取 reviewer 结果。显式 deny 在第一层
 * 返回 forbidden，后续用户决定、自动规则和 SDK hook 都没有覆盖它的入口。
 */
export class ApprovalPolicyEngine {
  evaluate(input: {
    context: AgentStepContext
    descriptor: AgentToolDescriptorSource
    action: ApprovalAction
  }): ApprovalPolicyOutcome {
    const permission = resolveToolPermission(
      input.descriptor.name,
      input.context.permissions.toolRules,
    )
    if (permission?.decision === 'always_deny') {
      return {
        kind: 'forbidden',
        reason: `ToolPolicy 禁止工具 '${input.descriptor.name}'：命中规则 '${permission.toolPattern}'。`,
      }
    }

    const reasons: string[] = []
    if (permission?.decision === 'always_ask') reasons.push(`权限规则 '${permission.toolPattern}' 要求审批`)
    if (input.descriptor.approvalAction !== null) reasons.push(`工具声明审批动作 '${input.descriptor.approvalAction}'`)
    if (input.descriptor.effect === 'destructive') reasons.push('工具具有破坏性副作用')
    if (input.context.approvalPolicy.interruptToolNames.includes(input.descriptor.name)) {
      reasons.push('运行时审批清单要求中断')
    }

    if (reasons.length === 0) return { kind: 'allowed', approvalDecision: 'not_required' }
    return {
      kind: 'approval_required',
      action: input.action,
      reason: reasons.join('；'),
    }
  }
}

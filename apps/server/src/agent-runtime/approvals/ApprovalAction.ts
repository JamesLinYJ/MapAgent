// +-------------------------------------------------------------------------
//
//   地理智能平台 - Canonical 审批动作
//
//   文件:       ApprovalAction.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  approvalActionKindSchema,
  approvalActionSchema,
  type ApprovalAction,
  type ApprovalActionKind,
} from '@geo-agent-platform/shared-types/approval-runtime'
import type {
  AgentToolDescriptorSource,
} from '@geo-agent-platform/shared-types/tool-runtime'

import { agentContextDigest } from '../step/agentContextDigest.js'

export interface BuildApprovalActionInput {
  workspaceId: string
  descriptor: AgentToolDescriptorSource
  args: Record<string, unknown>
  contextDigest: string
  deniedReadResourceIds?: readonly string[]
}

export function buildApprovalAction(input: BuildApprovalActionInput): ApprovalAction {
  const resourceIds = collectResourceIds(input.args)
  const deniedReadResourceIds = canonicalStrings(input.deniedReadResourceIds ?? [])
  return approvalActionSchema.parse({
    kind: approvalKind(input.descriptor),
    workspaceId: input.workspaceId,
    toolName: input.descriptor.name,
    toolKind: input.descriptor.kind,
    effect: input.descriptor.effect,
    resourceIds,
    permissionScope: {
      requiredCapabilities: canonicalStrings(input.descriptor.requiredCapabilities),
      deniedReadResourceIds,
    },
    argsDigest: agentContextDigest(input.args),
    contextDigest: input.contextDigest,
  })
}

export function approvalActionKey(action: ApprovalAction): string {
  return agentContextDigest({
    workspaceId: action.workspaceId,
    toolName: action.toolName,
    toolKind: action.toolKind,
    kind: action.kind,
    effect: action.effect,
    resourceIds: action.resourceIds,
    permissionScope: action.permissionScope,
  })
}

/**
 * 权限升级只能扩大请求，不能抹掉此前明确拒绝读取的资源。
 * 新动作仍会重新计算 key，因此 reviewer 能看到完整升级范围。
 */
export function preserveDeniedReads(
  action: ApprovalAction,
  deniedReadResourceIds: readonly string[],
): ApprovalAction {
  return approvalActionSchema.parse({
    ...action,
    permissionScope: {
      ...action.permissionScope,
      deniedReadResourceIds: canonicalStrings([
        ...action.permissionScope.deniedReadResourceIds,
        ...deniedReadResourceIds,
      ]),
    },
  })
}

function approvalKind(descriptor: AgentToolDescriptorSource): ApprovalActionKind {
  const explicit = descriptor.approvalAction?.trim() ?? ''
  const explicitKind = approvalActionKindSchema.safeParse(explicit)
  if (explicitKind.success) return explicitKind.data
  if (descriptor.kind === 'sandbox') {
    return /network/u.test(descriptor.name) ? 'network_access' : 'sandbox_command'
  }
  if (descriptor.kind === 'mcp') return 'mcp_tool_call'
  if (descriptor.kind === 'subagent' || descriptor.kind === 'handoff') return 'child_run_spawn'
  if (/permission|grant|authorize/u.test(`${explicit}:${descriptor.name}`)) return 'permission_request'
  if (/automation|schedule|cron/u.test(`${explicit}:${descriptor.name}`)) return 'automation_schedule'
  if (/layer/u.test(descriptor.name) && /delete|remove|purge/u.test(descriptor.name)) return 'layer_delete'
  if (/file/u.test(descriptor.name) && /write|edit|delete|remove|upload/u.test(descriptor.name)) return 'file_write'
  if (/publish|export|send/u.test(descriptor.name)) return 'external_publish'
  if (descriptor.effect === 'external_write') return 'external_publish'
  return 'world_write'
}

function collectResourceIds(args: Record<string, unknown>): string[] {
  const result: string[] = []
  visit(args, [], result)
  return canonicalStrings(result)
}

function visit(value: unknown, path: string[], result: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, [...path, String(index)], result))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'workflowStepId') continue
    const nextPath = [...path, key]
    if (isResourceKey(key)) {
      if (typeof nested === 'string' && nested.trim()) {
        result.push(`${nextPath.join('.')}:${nested.trim()}`)
      } else if (Array.isArray(nested)) {
        for (const item of nested) {
          if (typeof item === 'string' && item.trim()) result.push(`${nextPath.join('.')}:${item.trim()}`)
        }
      }
    }
    visit(nested, nextPath, result)
  }
}

function isResourceKey(key: string): boolean {
  return /(?:Id|Ids|Key|Keys|Ref|Refs)$/u.test(key) && !isSensitiveKey(key)
}

function isSensitiveKey(key: string): boolean {
  return /(?:password|passphrase|secret|token|credential|authorization|cookie|apiKey|privateKey|accessKey|signingKey)/iu
    .test(key)
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
}

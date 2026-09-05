// +-------------------------------------------------------------------------
//
//   地理智能平台 - 审批策略引擎测试
//
//   文件:       ApprovalPolicyEngine.test.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { ApprovalPolicyEngine } from './ApprovalPolicyEngine.js'
import { approvalActionKey, buildApprovalAction, preserveDeniedReads } from './ApprovalAction.js'
import { stepContext, toolDescriptor } from './approvalTestFixtures.js'

describe('ApprovalPolicyEngine', () => {
  it('never lets approval settings override a ToolPolicy deny', () => {
    const context = stepContext({
      toolRules: [{ toolPattern: 'delete_*', decision: 'always_deny', priority: 100 }],
      interruptToolNames: ['delete_layer'],
    })
    const descriptor = toolDescriptor({ name: 'delete_layer', effect: 'destructive', approvalAction: 'layer_delete' })
    const action = buildApprovalAction({
      workspaceId: 'workspace_1', descriptor, args: { layerId: 'layer_1' }, contextDigest: context.contextDigest,
    })
    expect(new ApprovalPolicyEngine().evaluate({ context, descriptor, action })).toMatchObject({
      kind: 'forbidden',
    })
  })

  it('adds approval for an ask rule without weakening intrinsic destructive approval', () => {
    const context = stepContext({
      toolRules: [{ toolPattern: '*', decision: 'always_allow', priority: 1 }],
    })
    const descriptor = toolDescriptor({ effect: 'destructive', approvalAction: 'world_write' })
    const action = buildApprovalAction({
      workspaceId: 'workspace_1', descriptor, args: {}, contextDigest: context.contextDigest,
    })
    expect(new ApprovalPolicyEngine().evaluate({ context, descriptor, action }).kind)
      .toBe('approval_required')
  })

  it('preserves denied reads across escalation and changes the canonical action key', () => {
    const context = stepContext()
    const descriptor = toolDescriptor({ effect: 'world_write', approvalAction: 'world_write' })
    const initial = buildApprovalAction({
      workspaceId: 'workspace_1', descriptor, args: { layerId: 'layer_1' }, contextDigest: context.contextDigest,
      deniedReadResourceIds: ['file_a'],
    })
    const escalated = preserveDeniedReads(initial, ['file_b', 'file_a'])
    expect(escalated.permissionScope.deniedReadResourceIds).toEqual(['file_a', 'file_b'])
    expect(approvalActionKey(escalated)).not.toBe(approvalActionKey(initial))
  })

  it('keeps credentials out of durable resource identities', () => {
    const context = stepContext()
    const descriptor = toolDescriptor({ effect: 'world_write', approvalAction: 'world_write' })
    const action = buildApprovalAction({
      workspaceId: 'workspace_1',
      descriptor,
      args: {
        layerKey: 'layer_public',
        apiKey: 'credential-value',
        accessToken: 'access-value',
      },
      contextDigest: context.contextDigest,
    })

    expect(action.resourceIds).toEqual(['layerKey:layer_public'])
    expect(JSON.stringify(action)).not.toContain('credential-value')
    expect(JSON.stringify(action)).not.toContain('access-value')
    expect(approvalActionKey({ ...action, toolKind: 'mcp' }))
      .not.toBe(approvalActionKey(action))
  })
})

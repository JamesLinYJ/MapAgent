// +-------------------------------------------------------------------------
//
//   地理智能平台 - 用户决策投影测试
//
//   文件:       conversationDecision.test.ts
//
//   日期:       2026年06月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 用户决策面板只从 canonical DecisionRequest 派生。
// 测试覆盖服务端 pending 决策优先级；composer 执行方式选择不进入服务端决策流。

import { describe, expect, it } from 'vitest'
import type { DecisionRequest } from '@geo-agent-platform/shared-types'
import { pickPendingDecision, workflowPreviewFromDecision } from '../features/conversation/useConversation'

describe('conversation decision projection', () => {
  it('优先显示 pending approval，其次才是 pending clarification', () => {
    const clarification = decision({ decisionId: 'clarification_1', kind: 'clarification' })
    const approval = decision({ decisionId: 'approval_1', kind: 'approval' })

    expect(pickPendingDecision([clarification, approval])?.decisionId).toBe('approval_1')
  })

  it('忽略已经 resolved 的决策', () => {
    const answered = decision({
      decisionId: 'clarification_done',
      kind: 'clarification',
      status: 'answered',
      resolvedAt: '2026-06-30T00:00:00.000Z',
    })
    const pending = decision({ decisionId: 'clarification_pending', kind: 'clarification' })

    expect(pickPendingDecision([answered, pending])?.decisionId).toBe('clarification_pending')
  })

  it('不把本地 execution_mode 当作待处理服务端决策', () => {
    const local = decision({ decisionId: 'execution_mode', kind: 'execution_mode' })

    expect(pickPendingDecision([local])).toBeNull()
  })

  it('从工作流审批参数投影用户可核验的目标和步骤', () => {
    const approval = decision({
      kind: 'approval',
      payload: {
        action: 'submit_agent_workflow',
        args: {
          workflow: {
            goal: '生成杭州市行政区划地图',
            steps: [{
              stepId: 'step_query',
              title: '查询行政区划图层',
              toolName: 'query_layer',
              ownerAgentId: 'supervisor',
              reason: '取得真实区县边界',
              dependsOn: [],
            }],
          },
        },
      },
    })

    expect(workflowPreviewFromDecision(approval)).toEqual({
      goal: '生成杭州市行政区划地图',
      steps: [{
        stepId: 'step_query',
        title: '查询行政区划图层',
        kind: '',
        phase: null,
        toolName: 'query_layer',
        ownerAgentId: 'supervisor',
        args: {},
        reason: '取得真实区县边界',
        dependsOn: [],
      }],
    })
  })

  it('工作流修订再次审批时仍展示完整修订步骤', () => {
    const approval = decision({
      kind: 'approval',
      payload: {
        action: 'revise_agent_workflow',
        args: {
          workflow: {
            goal: '改由空间子智能体核验边界',
            steps: [{
              stepId: 'step_agent',
              title: '委托空间分析助手',
              toolName: 'spatial_analyst',
              ownerAgentId: 'spatial_analyst',
              reason: '原数据链失败后采用已配置的专业能力',
              dependsOn: [],
            }],
          },
        },
      },
    })

    expect(workflowPreviewFromDecision(approval)).toMatchObject({
      goal: '改由空间子智能体核验边界',
      steps: [expect.objectContaining({ toolName: 'spatial_analyst' })],
    })
  })
})

function decision(overrides: Partial<DecisionRequest>): DecisionRequest {
  return {
    decisionId: overrides.decisionId ?? 'decision_1',
    kind: overrides.kind ?? 'clarification',
    title: overrides.title ?? '需要确认',
    question: overrides.question ?? '请选择下一步。',
    description: overrides.description ?? '',
    options: overrides.options ?? [],
    allowFreeText: overrides.allowFreeText ?? false,
    status: overrides.status ?? 'pending',
    payload: overrides.payload ?? {},
    createdAt: overrides.createdAt ?? '2026-06-30T00:00:00.000Z',
    resolvedAt: overrides.resolvedAt ?? null,
  }
}

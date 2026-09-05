// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作流侧栏视图模型测试
//
//   文件:       workspaceWorkflowModel.test.ts
//
//   日期:       2026年07月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { agentStateSchema } from '@geo-agent-platform/shared-types'
import { deriveWorkspaceWorkflowView } from '../app/layout/WorkspaceWorkflowModel'

describe('deriveWorkspaceWorkflowView', () => {
  it('审批前从 canonical 决策参数投影 Automation 草案', () => {
    const state = agentStateSchema.parse({
      sessionId: 'session_1',
      userQuery: '杭州接下来三小时会不会下雨？',
      decisions: [{
        decisionId: 'decision_1',
        kind: 'approval',
        title: '批准这个智能体工作流？',
        question: '批准这个智能体工作流？',
        status: 'pending',
        payload: {
          action: 'submit_agent_workflow',
          args: {
            workflow: {
              goal: '分析杭州未来三小时降雨',
              steps: [{
                stepId: 'step_1',
                title: '执行短临监测',
                kind: 'automation',
                toolName: 'execute_automation',
                ownerAgentId: 'supervisor',
                args: { automation_id: 'meteorological_nowcast_monitor' },
                reason: '使用已经发布的确定性流程',
                dependsOn: [],
              }],
            },
          },
        },
        createdAt: '2026-07-20T00:00:00.000Z',
      }],
    })

    expect(deriveWorkspaceWorkflowView(state)).toMatchObject({
      goal: '分析杭州未来三小时降雨',
      statusLabel: '等待审批',
      awaitingApproval: true,
      steps: [{
        technicalLabel: 'Automation · meteorological_nowcast_monitor',
        statusLabel: '待执行',
      }],
    })
  })

  it('执行后投影步骤结果和真正参与的子智能体', () => {
    const state = agentStateSchema.parse({
      sessionId: 'session_1',
      userQuery: '查询杭州区县',
      agentWorkflow: {
        agentWorkflowId: 'workflow_1',
        revision: 1,
        goal: '查询并汇总杭州区县',
        status: 'running',
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:01:00.000Z',
        steps: [{
          stepId: 'step_agent',
          title: '空间分析助手查询区县',
          kind: 'agent',
          toolName: 'spatial_analyst',
          ownerAgentId: 'spatial_analyst',
          args: { query: '杭州区县' },
          reason: '委托专业助手',
          dependsOn: [],
          status: 'completed',
          resultSummary: '返回 13 个区县',
          completedAt: '2026-07-20T00:01:00.000Z',
        }],
      },
      subAgents: [
        {
          agentId: 'spatial_analyst',
          name: '空间分析助手',
          role: '空间分析',
          status: 'completed',
          summary: '完成空间查询',
          stepIds: ['step_agent'],
        },
        {
          agentId: 'unused_agent',
          name: '未参与助手',
          role: '备用',
          status: 'pending',
          summary: '待命',
          stepIds: [],
        },
      ],
    })

    expect(deriveWorkspaceWorkflowView(state)).toMatchObject({
      completedCount: 1,
      steps: [{ detail: '返回 13 个区县', technicalLabel: 'Agent · spatial_analyst' }],
      agents: [{ name: '空间分析助手', statusLabel: '已返回' }],
    })
  })

  it('没有显式 workflow 时仍投影正在运行的 handoff 子智能体', () => {
    const state = agentStateSchema.parse({
      sessionId: 'session_1',
      userQuery: '接管并核验当前地图成果',
      subAgents: [{
        agentId: 'quality_reviewer',
        name: '质量核验助手',
        role: '成果核验',
        delegationMode: 'handoff',
        status: 'running',
        summary: '检查坐标系和数据年份',
        currentStep: '核对元数据',
        progressPercent: 45,
        activityCount: 3,
        lastActivityAt: '2026-08-08T04:00:00.000Z',
        stalled: true,
        resultRefs: ['artifact://map_1'],
        deliveryEvidence: [{ claim: '已读取图层元数据', source: 'artifact://map_1' }],
      }],
    })

    expect(deriveWorkspaceWorkflowView(state)).toMatchObject({
      goal: '接管并核验当前地图成果',
      status: 'running',
      statusLabel: '执行中',
      revision: 0,
      steps: [],
      agents: [{
        agentId: 'quality_reviewer',
        delegationMode: 'handoff',
        statusLabel: '疑似停滞',
        currentStep: '核对元数据',
        progressPercent: 45,
        resultRefs: ['artifact://map_1'],
      }],
    })
  })
})

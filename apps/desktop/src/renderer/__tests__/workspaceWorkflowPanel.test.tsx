// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作流文档面板测试
//
//   文件:       workspaceWorkflowPanel.test.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { agentStateSchema } from '@geo-agent-platform/shared-types'

import { WorkspaceWorkflowPanel } from '../app/layout/WorkspaceWorkflowPanel'

describe('WorkspaceWorkflowPanel', () => {
  it('没有工作流时仍提供完整文档空状态和下一步', () => {
    const html = renderToStaticMarkup(<WorkspaceWorkflowPanel agentState={null} />)

    expect(html).toContain('aria-label="智能体工作流"')
    expect(html).toContain('尚未生成工作流')
    expect(html).toContain('这里会同步展示智能体的执行计划')
    expect(html).toContain('aria-label="开始工作流"')
    expect(html).toContain('在右侧智能对话中说明要解决的问题和期望成果')
    expect(html).toContain('下一步：在右侧智能对话输入目标并发送')
    expect(html).not.toBe('')
  })

  it('直接展示无 workflow 的 handoff 协作状态和详情入口', () => {
    const agentState = agentStateSchema.parse({
      sessionId: 'session_1',
      userQuery: '核验地图成果',
      subAgents: [{
        agentId: 'quality_reviewer',
        name: '质量核验助手',
        role: '成果核验',
        delegationMode: 'handoff',
        status: 'running',
        currentStep: '核对元数据',
        progressPercent: 45,
        stalled: true,
      }],
    })
    const html = renderToStaticMarkup(<WorkspaceWorkflowPanel agentState={agentState} runId="run_1" />)

    expect(html).toContain('1 个协作智能体')
    expect(html).toContain('质量核验助手')
    expect(html).toContain('成果核验 · Handoff')
    expect(html).toContain('疑似停滞')
    expect(html).toContain('aria-expanded="false"')
  })
})

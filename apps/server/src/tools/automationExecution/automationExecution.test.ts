// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 系统工具交付测试
//
//   文件:       automationExecution.test.ts
//
//   日期:       2026年07月19日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import type { AutomationInvocationService } from '../../automations/automationInvocationService.js'
import type { ToolContext } from '../../framework/types.js'
import { ToolRegistry } from '../../framework/registry.js'
import { createAutomationExecutionProvider } from './index.js'

describe('automation execution tool delivery', () => {
  it('returns warnings, verifiable artifacts, and the persisted automation run id to the model', async () => {
    const executeAttached = vi.fn(async () => ({
      automationRunId: 'automation_run_1',
      automationId: 'meteorological_nowcast_monitor',
      answer: '杭州有 5 个区县达到有效降雨阈值。',
      outputs: {
        answer: '杭州有 5 个区县达到有效降雨阈值。',
        warnings: ['区划范围缺少一个无效面要素。'],
      },
      artifacts: [{
        artifactId: 'artifact_map',
        runId: 'run_1',
        artifactType: 'raster_cog',
        name: '杭州短临降水地图',
        uri: '/api/v1/results/artifact_map/file',
        display: { surfaces: ['download'], primarySurface: 'download' },
        metadata: { relativePath: 'artifacts/run_1/nowcast.tif' },
        isIntermediate: false,
      }],
    }))
    const service = { executeAttached } as unknown as AutomationInvocationService
    const provider = createAutomationExecutionProvider(service)
    const tool = provider.tools()
      .find(candidate => candidate.name === 'execute_automation')
    if (!tool) throw new Error('execute_automation 工具缺失')
    expect(tool.agentResultMode).toBe('continue')
    const registry = new ToolRegistry()
    registry.register(provider)

    const result = await registry.execute('execute_automation', {
      automation_id: 'meteorological_nowcast_monitor',
      prompt: '分析杭州未来三小时降雨。',
      parameters: { horizonMinutes: 180, regionLayerKey: 'hangzhou_districts' },
    }, runtime())

    expect(result.warnings).toEqual(['区划范围缺少一个无效面要素。'])
    expect(result.artifacts).toEqual([expect.objectContaining({
      artifactId: 'artifact_map',
      relativePath: 'artifacts/run_1/nowcast.tif',
    })])
    expect(result.modelOutput).toContain('范围或数据警告：区划范围缺少一个无效面要素。')
    expect(result.modelOutput).toContain('杭州短临降水地图：/api/v1/results/artifact_map/file')
    expect(result.modelOutput).toContain('自动化运行记录：automation_run_1')
  })
})

function runtime(): ToolContext {
  return {
    runId: 'run_1',
    sessionId: 'session_1',
    threadId: 'thread_1',
    signal: new AbortController().signal,
    auth: {
      userId: 'user_1',
      subject: 'user_1',
      email: 'user@example.com',
      displayName: '测试用户',
      authSessionId: 'auth_session_1',
      authSessionExpiresAt: null,
      csrfToken: 'csrf',
      defaultWorkspaceId: 'workspace_1',
      roles: [{ workspaceId: 'workspace_1', role: 'analyst' }],
    },
    state: new Map(),
    resolveValueRef: () => { throw new Error('测试不应解析 valueRef') },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}

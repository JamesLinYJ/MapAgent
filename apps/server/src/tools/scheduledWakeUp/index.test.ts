// +-------------------------------------------------------------------------
//
//   地理智能平台 - 定时任务工具契约测试
//
//   文件:       index.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../framework/types.js'
import { validateToolProvider } from '../../framework/validation.js'
import type { AuthContext } from '../../security/types.js'
import type { ScheduledTaskService } from '../../automations/scheduledTaskService.js'
import { createScheduledWakeUpProvider } from './index.js'

const TEST_AUTH: AuthContext = {
  userId: 'user_test',
  subject: 'auth_user_test',
  email: 'tester@geo-agent-platform.local',
  displayName: '测试用户',
  authSessionId: 'auth_session_test',
  authSessionExpiresAt: null,
  csrfToken: 'csrf_test',
  defaultWorkspaceId: 'workspace_test',
  roles: [{ workspaceId: 'workspace_test', role: 'platform_admin' }],
}

describe('ScheduledWakeUp provider', () => {
  it('separates approval-free reads from approved mutations', async () => {
    const listScheduledTasks = vi.fn().mockResolvedValue({
      tasks: [],
      automationRuns: [],
    })
    const provider = createScheduledWakeUpProvider({
      listScheduledTasks,
    } as unknown as ScheduledTaskService)

    expect(() => validateToolProvider(provider)).not.toThrow()
    const listTool = provider.tools().find(tool => tool.name === 'list_scheduled_tasks')
    const mutationTool = provider.tools().find(tool => tool.name === 'ScheduledWakeUp')
    if (!listTool || !mutationTool) throw new Error('定时任务 Provider 工具不完整。')

    expect(listTool).toMatchObject({
      isReadOnly: true,
      isDestructive: false,
    })
    expect(listTool.requiresApproval).toBeUndefined()
    expect(mutationTool).toMatchObject({
      isReadOnly: false,
      isDestructive: false,
      requiresApproval: true,
    })
    expect(mutationTool.parameters?.safeParse({ operation: 'list' }).success).toBe(false)

    const result = await listTool.handler({}, toolContext())
    expect(listScheduledTasks).toHaveBeenCalledWith(TEST_AUTH)
    expect(result).toMatchObject({
      source: 'list_scheduled_tasks',
      payload: { tasks: [], automationRuns: [] },
    })
  })
})

function toolContext(): ToolContext {
  return {
    runId: 'run_test',
    sessionId: 'session_test',
    threadId: 'thread_test',
    signal: new AbortController().signal,
    auth: TEST_AUTH,
    state: new Map(),
    resolveValueRef: () => {
      throw new Error('测试不需要 valueRef。')
    },
    invokeStructuredModel: async () => ({}),
    log: () => {},
  }
}

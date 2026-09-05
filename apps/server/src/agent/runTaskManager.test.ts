// +-------------------------------------------------------------------------
//
//   地理智能平台 - 后台运行任务管理器测试
//
//   文件:       runTaskManager.test.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { AnalysisRun } from '../schemas/types.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import type { OpenAIAgentsRuntime, RunOptions } from './runtime.js'
import { RunTaskManager } from './runTaskManager.js'
import { BackgroundTaskRegistry } from '../automations/backgroundTaskRegistry.js'

describe('RunTaskManager', () => {
  it('tracks a background run and calls completion callback after runtime finishes', async () => {
    const run = testRun('run_1')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const runtime = {
      run: vi.fn(async () => {
        await gate
        return run
      }),
    } as unknown as OpenAIAgentsRuntime
    const manager = new RunTaskManager(runtime, testStore(run))
    const onComplete = vi.fn()

    const task = manager.start(testOptions(run.id), { onComplete })

    expect(manager.activeRunIds()).toEqual([run.id])
    release()
    await expect(task).resolves.toBe(run)
    expect(onComplete).toHaveBeenCalledWith(run.id)
    expect(manager.activeRunIds()).toEqual([])
  })

  it('rejects duplicate launches for the same run id', async () => {
    const run = testRun('run_2')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const runtime = {
      run: vi.fn(async () => {
        await gate
        return run
      }),
    } as unknown as OpenAIAgentsRuntime
    const manager = new RunTaskManager(runtime, testStore(run))

    const task = manager.start(testOptions(run.id))

    expect(() => manager.start(testOptions(run.id))).toThrow("运行 'run_2' 已在后台执行中")
    release()
    await task
  })

  it('delegates cancellation to the OpenAI Agents runtime', async () => {
    const run = testRun('run_3')
    const cancel = vi.fn(async () => run)
    const runtime = { cancel } as unknown as OpenAIAgentsRuntime
    const manager = new RunTaskManager(runtime, testStore(run))

    await expect(manager.cancel(run.id)).resolves.toBe(run)
    expect(cancel).toHaveBeenCalledWith(run.id)
  })

  it('acknowledges an approval before the resumed agent run completes', async () => {
    const run = testRun('run_approval')
    const queued = { ...run, status: 'queued' as const }
    const completed = { ...run, status: 'completed' as const }
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const runtime = {
      acceptApprovalDecision: vi.fn(async () => ({ run: queued, accepted: true })),
      continueApprovalDecision: vi.fn(async () => {
        await gate
        return completed
      }),
    } as unknown as OpenAIAgentsRuntime
    const manager = new RunTaskManager(runtime, testStore(run))
    const onComplete = vi.fn()

    const acknowledged = await manager.respondToApproval(
      run.id,
      'approval_1',
      true,
      null,
      { onComplete },
    )

    expect(acknowledged.status).toBe('queued')
    expect(manager.activeRunIds()).toEqual([run.id])
    expect(onComplete).not.toHaveBeenCalled()
    release()
    await manager.drain()
    expect(onComplete).toHaveBeenCalledWith(run.id)
    expect(manager.activeRunIds()).toEqual([])
  })

  it('propagates background cancellation into the runtime signal', async () => {
    const run = testRun('run_4')
    let receivedSignal: AbortSignal | undefined
    const cancelledRun = { ...run, status: 'cancelled' as const }
    const runtime = {
      run: vi.fn((options: RunOptions) => new Promise<AnalysisRun>(resolve => {
        receivedSignal = options.signal
        options.signal?.addEventListener('abort', () => resolve(cancelledRun), { once: true })
      })),
      cancel: vi.fn(async () => cancelledRun),
    } as unknown as OpenAIAgentsRuntime
    const backgroundTasks = new BackgroundTaskRegistry()
    const manager = new RunTaskManager(runtime, testStore(run), backgroundTasks)

    const task = manager.start(testOptions(run.id))
    await manager.cancel(run.id)

    await expect(task).resolves.toEqual(cancelledRun)
    expect(receivedSignal?.aborted).toBe(true)
    expect(backgroundTasks.get(run.id)?.status).toBe('cancelled')
  })
})

function testOptions(runId: string): RunOptions {
  return {
    runId,
    threadId: 'thread_1',
    sessionId: 'session_1',
    query: '测试后台运行',
    provider: 'deepseek',
    modelName: 'test-model',
    runtimeConfig: {
      supervisor: { name: 'Supervisor', systemPrompt: '测试' },
      subAgents: [],
      enabledTools: [],
      approvalInterruptTools: [],
      toolExecution: { sandbox: 'workspace-write', allowedPrompts: [] },
      context: {
        maxMessages: 20,
        maxTokens: 12000,
        compactionThreshold: 0.8,
        inlineToolResultMaxChars: 2000,
      },
      maxTurns: 8,
      memory: {
        enabled: false,
        autoExtract: false,
        autoDream: false,
        sessionMemory: false,
      },
    },
  }
}

function testRun(id: string): AnalysisRun {
  return {
    id,
    sessionId: 'session_1',
    threadId: 'thread_1',
    userQuery: '测试后台运行',
    status: 'running',
    modelProvider: 'deepseek',
    modelName: 'test-model',
    createdAt: '2026-07-08T00:00:00.000Z',
    updatedAt: '2026-07-08T00:00:00.000Z',
    runtimeConfigSnapshot: null,
    state: {
      sessionId: 'session_1',
      threadId: 'thread_1',
      userQuery: '测试后台运行',
      parsedIntent: null,
      clarification: null,
      placeResolution: null,
      contextReferences: [],
      contextResolution: null,
      runLifecycle: { status: 'created', reason: null, updatedAt: null },
      agentWorkflow: null,
      currentStep: 0,
      loopIteration: 0,
      loopPhase: 'idle',
      loopTrace: [],
      todos: [],
      tasks: [],
      planMode: false,
      subAgents: [],
      activeSkills: [],
      activeMcpServers: [],
      decisions: [],
      approvals: [],
      toolResults: [],
      toolValueRefs: [],
      artifacts: [],
      selectedDataSources: [],
      planRepairAttempts: 0,
      warnings: [],
      errors: [],
      failedStepId: null,
      failedTool: null,
      modelProvider: 'deepseek',
      modelName: 'test-model',
    },
  }
}

function testStore(run: AnalysisRun): PlatformPersistenceFacade {
  return {
    getRun: () => run,
  } as unknown as PlatformPersistenceFacade
}

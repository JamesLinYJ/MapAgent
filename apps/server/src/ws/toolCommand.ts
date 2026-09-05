// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 直接工具执行命令
//
//   文件:       toolCommand.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 平台 WS 直接工具执行命令。
// 管理员调试入口和 Automation 工具节点共享 executePersistedTool；这里只拥有权限、运行创建和终态。

import type { AgentRuntimeConfig } from '../schemas/types.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { ModelCompletionService } from '../model/modelResultCache.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'
import { assertDirectToolRunAllowed } from '../security/toolExecutionPolicy.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import { executePersistedTool } from '../tools/persistentToolExecutor.js'
import type { ToolResultCommitService } from '../tools/resultPersistence.js'
import { optionalString, requiredRecord, requiredString } from './payload.js'
import { resolveRuntimeConfig } from './runtimeConfig.js'
import type { WsCommandRegistry } from './commandRegistry.js'

export function registerToolCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'tool:run',
    handler: (payload, context) => executeTool(
      payload,
      context.dependencies.store,
      context.dependencies.toolRegistry,
      context.dependencies.modelRegistry,
      context.dependencies.defaultRuntimeConfig,
      context.dependencies.security,
      requireAuth(context.auth),
      context.dependencies.resultCommitService,
      context.dependencies.modelCompletions,
    ),
  })
}

async function executeTool(
  payload: Record<string, unknown>,
  store: PlatformPersistenceFacade,
  registry: ToolRegistry,
  modelRegistry: ModelAdapterRegistry,
  runtimeConfigDefaults: AgentRuntimeConfig | undefined,
  security: SecurityServices,
  auth: AuthContext,
  resultCommitService: Pick<ToolResultCommitService, 'commit'>,
  modelCompletions?: ModelCompletionService,
) {
  const toolName = requiredString(payload, 'toolName')
  await assertDirectToolRunAllowed(auth, security.authorization, registry, toolName)
  const tool = registry.get(toolName)
  if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
  let runId = optionalString(payload.runId)
  let directRun = false
  if (!runId) {
    const sessionId = requiredString(payload, 'sessionId')
    let threadId = optionalString(payload.threadId)
    if (!threadId) threadId = (await store.createThread(sessionId, `工具：${tool.label}`)).id
    const created = await store.createRun(sessionId, `执行工具：${tool.label}`, {
      threadId,
      modelProvider: modelRegistry.defaultProvider || null,
      runtimeConfigSnapshot: await resolveRuntimeConfig(store.runtimeConfiguration, runtimeConfigDefaults),
    })
    runId = created.id
    directRun = true
    await store.updateRunStatus(runId, 'running')
  }
  try {
    const result = await executePersistedTool({
      runId,
      toolName,
      args: requiredRecord(payload, 'args'),
      auth,
      executionSurface: 'developer',
    }, {
      store,
      runtimeConfiguration: store.runtimeConfiguration,
      registry,
      modelRegistry,
      ...(modelCompletions ? { modelCompletions } : {}),
      resultCommitService,
      defaultRuntimeConfig: runtimeConfigDefaults,
    })
    if (directRun) await store.completeRun(runId, 'completed')
    return { result, run: store.getRun(runId) }
  } catch (error) {
    if (directRun) {
      const run = store.getRun(runId)
      const message = error instanceof Error && error.message.trim() ? error.message : '工具执行失败。'
      await store.updateRunState(runId, { errors: [...run.state.errors, message], failedTool: toolName })
      await store.completeRun(runId, 'failed')
    }
    throw error
  }
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 记忆命令
//
//   文件:       memoryCommand.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 统一处理 thread memory、长期 memory 和 instruction memory 查询命令。handler
// 只负责授权与分发，记忆文件算法和 Zod schema 仍由 memory service 负责。

import {
  createMemoryRuntime,
  deleteMemory,
  dreamMemories,
  extractMemoriesFromThread,
  listMemories,
  readMemory,
  rebuildSessionMemory,
  searchMemories,
  writeMemory,
} from '../memory/service.js'
import { memoryScopeSchema, memoryTypeSchema } from '../memory/schemas.js'
import { scopeRuntimeConfigToPrincipal } from '../security/runtimePrincipalScope.js'
import type { AuthContext } from '../security/types.js'
import type { ClientMsg } from './protocol.js'
import type { WsDependencies } from './dependencies.js'
import type { WsCommandRegistry } from './commandRegistry.js'
import { isRecord, optionalNonNegativeInteger, optionalString, requiredString } from './payload.js'
import { resolveRuntimeConfig } from './runtimeConfig.js'
import {
  makeMemoryExtractor,
  makeOptionalStructuredSelector,
  makeOptionalMemoryDreamer,
  makeSummarizer,
} from './modelSelectors.js'

export function registerMemoryCommands(registry: WsCommandRegistry): void {
  const memoryCommands = [
    'thread:memory:get',
    'thread:memory:update',
    'thread:memory:rebuild',
    'memory:list',
    'memory:read',
    'memory:write',
    'memory:delete',
    'memory:search',
    'memory:extract',
    'memory:dream',
    'memory:session:get',
    'memory:session:rebuild',
    'memory:instructions:list',
  ] as const
  for (const type of memoryCommands) {
    registry.register({
      type,
      handler: (payload, context) => handleMemoryCommand(
        type,
        requireMemoryPayload(payload),
        context.dependencies,
        requireMemoryAuth(context.auth),
      ),
    })
  }
}

function requireMemoryPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error('记忆命令 payload 必须是对象。')
  return payload
}

function requireMemoryAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('记忆命令需要登录。')
  return auth
}

async function handleMemoryCommand(
  command: ClientMsg['type'],
  payload: Record<string, unknown>,
  dependencies: WsDependencies,
  auth: AuthContext,
): Promise<unknown> {
  const { store, modelRegistry } = dependencies
  const cached = dependencies.modelCompletions
    ? { service: dependencies.modelCompletions, workspaceId: auth.defaultWorkspaceId }
    : undefined

  const resolveScopedConfig = async () => scopeRuntimeConfigToPrincipal(
    store.runtimeRoot,
    await resolveRuntimeConfig(store.runtimeConfiguration, dependencies.defaultRuntimeConfig),
    auth,
  )

  switch (command) {
    case 'thread:memory:get':
      return store.getThreadMemory(requiredString(payload, 'threadId'))
    case 'thread:memory:update':
      return store.updateThreadMemory(
        requiredString(payload, 'threadId'),
        requiredString(payload, 'content'),
        optionalNonNegativeInteger(payload.expectedVersion, 'expectedVersion'),
      )
    case 'thread:memory:rebuild': {
      const threadId = requiredString(payload, 'threadId')
      const config = await resolveScopedConfig()
      return rebuildSessionMemory(
        store,
        threadId,
        config.context,
        makeSummarizer(modelRegistry, config, optionalString(payload.provider), optionalString(payload.modelName), cached),
        true,
      )
    }
    case 'memory:list': {
      const config = await resolveScopedConfig()
      const runtimeMemory = createMemoryRuntime(store.runtimeRoot, config.context)
      const scope = optionalString(payload.scope)
      const records = await listMemories(runtimeMemory, scope ? memoryScopeSchema.parse(scope) : undefined)
      return { records, total: records.length }
    }
    case 'memory:read': {
      const config = await resolveScopedConfig()
      return readMemory(
        createMemoryRuntime(store.runtimeRoot, config.context),
        memoryScopeSchema.parse(requiredString(payload, 'scope')),
        requiredString(payload, 'relativePath'),
      )
    }
    case 'memory:write': {
      const config = await resolveScopedConfig()
      return writeMemory(createMemoryRuntime(store.runtimeRoot, config.context), {
        scope: memoryScopeSchema.parse(requiredString(payload, 'scope')),
        type: memoryTypeSchema.parse(requiredString(payload, 'type')),
        name: requiredString(payload, 'name'),
        description: requiredString(payload, 'description'),
        content: requiredString(payload, 'content'),
        relativePath: optionalString(payload.relativePath),
      })
    }
    case 'memory:delete': {
      const config = await resolveScopedConfig()
      return deleteMemory(
        createMemoryRuntime(store.runtimeRoot, config.context),
        memoryScopeSchema.parse(requiredString(payload, 'scope')),
        requiredString(payload, 'relativePath'),
      )
    }
    case 'memory:search': {
      const config = await resolveScopedConfig()
      const selector = makeOptionalStructuredSelector(
        modelRegistry,
        config,
        optionalString(payload.provider),
        optionalString(payload.modelName),
        cached,
      )
      const matches = await searchMemories(
        createMemoryRuntime(store.runtimeRoot, config.context),
        requiredString(payload, 'query'),
        selector,
      )
      return { matches, total: matches.length }
    }
    case 'memory:extract': {
      const threadId = requiredString(payload, 'threadId')
      const config = await resolveScopedConfig()
      const runId = optionalString(payload.runId) ?? store.listRunsForThread(threadId)[0]?.id
      if (!runId) throw new Error('memory:extract 需要 runId 或已有线程运行')
      const records = await extractMemoriesFromThread(
        createMemoryRuntime(store.runtimeRoot, config.context),
        store,
        threadId,
        runId,
        makeMemoryExtractor(
          modelRegistry,
          config,
          optionalString(payload.provider),
          optionalString(payload.modelName),
        ),
      )
      return { records, total: records.length }
    }
    case 'memory:dream': {
      const config = await resolveScopedConfig()
      return dreamMemories(
        createMemoryRuntime(store.runtimeRoot, config.context),
        makeOptionalMemoryDreamer(
          modelRegistry,
          config,
          optionalString(payload.provider),
          optionalString(payload.modelName),
        ),
        { force: payload.force === true },
      )
    }
    case 'memory:session:get':
      return store.getThreadMemory(requiredString(payload, 'threadId'))
    case 'memory:session:rebuild': {
      const threadId = requiredString(payload, 'threadId')
      const config = await resolveScopedConfig()
      return rebuildSessionMemory(
        store,
        threadId,
        config.context,
        makeSummarizer(modelRegistry, config, optionalString(payload.provider), optionalString(payload.modelName), cached),
        true,
      )
    }
    case 'memory:instructions:list': {
      const config = await resolveScopedConfig()
      return {
        enabled: config.context.instructionMemoryEnabled,
        entrypointName: config.context.instructionEntrypointName,
        records: [],
      }
    }
    default:
      throw new Error(`命令 '${command}' 不是记忆命令`)
  }
}

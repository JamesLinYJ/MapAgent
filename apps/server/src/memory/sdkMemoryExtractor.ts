// +-------------------------------------------------------------------------
//
//   地理智能平台 - SDK 专用记忆提取器
//
//   文件:       sdkMemoryExtractor.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Agent, Runner, tool, type Model } from '@openai/agents'
import { z } from 'zod'
import type { ModelAdapter } from '../model/registry.js'
import type { MemoryFileRecord } from './schemas.js'
import {
  deleteMemory,
  readMemory,
  searchMemories,
  writeMemory,
  type MemoryDreamer,
  type MemoryExtractor,
} from './service.js'
import { formatMemoryManifest } from './scan.js'

const memoryScopeSchema = z.enum(['private', 'team'])
const memoryTypeSchema = z.enum(['user', 'feedback', 'project', 'reference'])
const MAX_MEMORY_OPERATIONS = 10

/**
 * 自动记忆只获得四个记忆工具，不接入平台总工具注册表。
 * 读写结果由工具真实执行并回送 SDK，模型不再返回伪造的 operations JSON。
 */
export function createSdkMemoryExtractor(
  adapter: ModelAdapter,
  modelName: string,
  signal?: AbortSignal,
): MemoryExtractor {
  const model = requireMemoryToolModel(adapter, modelName)

  return async (runtime, input) => {
    let operationCount = 0
    const written = new Map<string, MemoryFileRecord>()
    const known = new Set(input.existing.map(record => memoryKey(record.scope, record.relativePath)))
    const countOperation = () => {
      operationCount += 1
      if (operationCount > MAX_MEMORY_OPERATIONS) {
        throw new Error(`自动记忆单次最多执行 ${MAX_MEMORY_OPERATIONS} 次记忆工具`)
      }
    }

    const readTool = tool({
      name: 'read_memory',
      description: '读取一个已存在的长期记忆正文，用于判断是否需要更新。',
      parameters: z.object({
        scope: memoryScopeSchema,
        relativePath: z.string().min(1),
      }),
      execute: async ({ scope, relativePath }) => {
        countOperation()
        try {
          const record = await readMemory(runtime, scope, relativePath)
          return JSON.stringify({ ok: true, record: publicRecord(record) })
        } catch (error) {
          return JSON.stringify({ ok: false, error: errorMessage(error), scope, relativePath })
        }
      },
    })
    const searchTool = tool({
      name: 'search_memory',
      description: '按关键词搜索长期记忆候选，不执行外部网络搜索。',
      parameters: z.object({ query: z.string().min(1) }),
      execute: async ({ query }) => {
        countOperation()
        const matches = await searchMemories(runtime, query)
        return JSON.stringify({
          ok: true,
          matches: matches.map(match => ({
            scope: match.record.scope,
            relativePath: match.record.relativePath,
            name: match.record.name,
            description: match.record.description,
            type: match.record.type,
            score: match.score,
          })),
        })
      },
    })
    const writeTool = tool({
      name: 'write_memory',
      description: '创建或更新一条长期记忆。只保存长期稳定且不能从项目事实源直接推导的信息。',
      parameters: z.object({
        scope: memoryScopeSchema,
        type: memoryTypeSchema,
        name: z.string().min(1),
        description: z.string().min(1),
        content: z.string().min(1),
        relativePath: z.string().min(1).nullable(),
      }),
      execute: async ({ relativePath, ...memory }) => {
        countOperation()
        const record = await writeMemory(runtime, {
          ...memory,
          ...(relativePath === null ? {} : { relativePath }),
        })
        const key = memoryKey(record.scope, record.relativePath)
        known.add(key)
        written.set(key, record)
        return JSON.stringify({ ok: true, record: publicRecord(record) })
      },
    })
    const forgetTool = tool({
      name: 'forget_memory',
      description: '删除明确过时或被用户要求遗忘的长期记忆。',
      parameters: z.object({
        scope: memoryScopeSchema,
        relativePath: z.string().min(1),
      }),
      execute: async ({ scope, relativePath }) => {
        countOperation()
        const key = memoryKey(scope, relativePath)
        if (!known.has(key)) throw new Error(`记忆 '${key}' 不存在，不能删除`)
        const deleted = await deleteMemory(runtime, scope, relativePath)
        known.delete(key)
        written.delete(key)
        return JSON.stringify({ ok: true, deleted })
      },
    })

    const agent = new Agent({
      name: '长期记忆提取器',
      instructions: [
        '只根据最近对话提取长期有用记忆。',
        '你只能调用 read_memory、search_memory、write_memory、forget_memory。',
        '如果没有长期价值，直接结束，不调用工具。',
        '不要保存可从仓库、Git 历史、工具结果或项目文档直接推导的事实。',
        '不要保存已经写在 AGENTS.md、工具提示词、测试或项目文档里的规则。',
        '不要保存历史运行日志、临时 Artifact 或当前运行中间状态。',
        '用户要求忽略记忆或不要保存时，不调用写入工具。',
        'MEMORY.md 只是索引；正文必须写入独立 topic file。',
      ].join('\n'),
      model,
      modelSettings: { temperature: 0 },
      tools: [readTool, searchTool, writeTool, forgetTool],
    })
    const prompt = [
      input.existing.length
        ? `已有记忆文件：\n${formatMemoryManifest(input.existing)}`
        : '已有记忆文件：无。',
      '',
      `最近对话：\n${formatTranscript(input.entries)}`,
    ].join('\n')
    await new Runner({
      model,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      toolExecution: { maxFunctionToolConcurrency: 1 },
    }).run(agent, prompt, {
      maxTurns: 8,
      ...(signal ? { signal } : {}),
    })
    return [...written.values()]
  }
}

export function createSdkMemoryDreamer(
  adapter: ModelAdapter,
  modelName: string,
  signal?: AbortSignal,
): MemoryDreamer {
  const model = requireMemoryToolModel(adapter, modelName)
  return async (runtime, records) => {
    let operationCount = 0
    let changed = false
    const known = new Set(records.map(record => memoryKey(record.scope, record.relativePath)))
    const writtenThisRun = new Set<string>()
    const countOperation = () => {
      operationCount += 1
      if (operationCount > MAX_MEMORY_OPERATIONS) {
        throw new Error(`自动记忆整理单次最多执行 ${MAX_MEMORY_OPERATIONS} 次记忆工具`)
      }
    }
    const writeTool = tool({
      name: 'write_memory',
      description: '创建或更新整理后的长期记忆主题文件。',
      parameters: z.object({
        scope: memoryScopeSchema,
        type: memoryTypeSchema,
        name: z.string().min(1),
        description: z.string().min(1),
        content: z.string().min(1),
        relativePath: z.string().min(1).nullable(),
      }),
      execute: async ({ relativePath, ...memory }) => {
        countOperation()
        const record = await writeMemory(runtime, {
          ...memory,
          ...(relativePath === null ? {} : { relativePath }),
        })
        const key = memoryKey(record.scope, record.relativePath)
        known.add(key)
        writtenThisRun.add(key)
        changed = true
        return JSON.stringify({ ok: true, record: publicRecord(record) })
      },
    })
    const forgetTool = tool({
      name: 'forget_memory',
      description: '删除确定重复、过期或已合并进其它主题文件的长期记忆。',
      parameters: z.object({
        scope: memoryScopeSchema,
        relativePath: z.string().min(1),
        reason: z.string().min(1),
      }),
      execute: async ({ scope, relativePath, reason }) => {
        countOperation()
        const key = memoryKey(scope, relativePath)
        if (!known.has(key)) throw new Error(`记忆 '${key}' 不存在，不能删除`)
        if (writtenThisRun.has(key)) throw new Error(`本轮刚写入的记忆 '${key}' 不能同时删除`)
        const deleted = await deleteMemory(runtime, scope, relativePath)
        known.delete(key)
        changed = true
        return JSON.stringify({ ok: true, deleted, reason })
      },
    })
    const agent = new Agent({
      name: '长期记忆整理器',
      instructions: [
        '整理给出的长期记忆主题文件：合并重复项，删除明确过期或低价值的内容。',
        '只允许调用 write_memory 和 forget_memory；如果无需变化，直接结束。',
        '更新已有文件时必须使用原 relativePath。',
        '不要保存可从仓库、Git、运行日志、AGENTS.md、测试或项目文档直接推导的事实。',
        '不确定时保持原样，不要制造新事实。',
      ].join('\n'),
      model,
      modelSettings: { temperature: 0 },
      tools: [writeTool, forgetTool],
    })
    const result = await new Runner({
      model,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      toolExecution: { maxFunctionToolConcurrency: 1 },
    }).run(agent, [
      '只在确有重复、过期或低价值内容时修改正文文件。',
      '',
      formatDetailedRecords(records),
    ].join('\n'), {
      maxTurns: 8,
      ...(signal ? { signal } : {}),
    })
    const summary = typeof result.finalOutput === 'string' ? result.finalOutput.trim() : ''
    return {
      changed,
      summary: summary || (changed ? '已通过记忆工具完成整理。' : '没有需要整理的记忆。'),
    }
  }
}

function formatTranscript(entries: Parameters<MemoryExtractor>[1]['entries']): string {
  return entries.flatMap(entry => {
    if (entry.kind === 'message') {
      return [`[${String(entry.payload.role ?? 'message')}] ${String(entry.payload.content ?? '')}`]
    }
    if (entry.kind === 'tool_call') {
      return [`[tool_call ${String(entry.payload.name ?? '')}] ${JSON.stringify(entry.payload.arguments ?? {})}`]
    }
    if (entry.kind === 'tool_result') {
      return [`[tool_result ${String(entry.payload.name ?? '')}] ${String(entry.payload.summary ?? entry.payload.content ?? '')}`]
    }
    return []
  }).join('\n')
}

function formatDetailedRecords(records: MemoryFileRecord[]): string {
  return records.map(record => [
    `## ${record.scope}:${record.relativePath}`,
    `name: ${record.name}`,
    `description: ${record.description}`,
    `type: ${record.type}`,
    '',
    record.content,
  ].join('\n')).join('\n\n---\n\n')
}

function publicRecord(record: MemoryFileRecord): Record<string, unknown> {
  return {
    scope: record.scope,
    relativePath: record.relativePath,
    type: record.type,
    name: record.name,
    description: record.description,
    content: record.content,
  }
}

function memoryKey(scope: string, relativePath: string): string {
  return `${scope}:${relativePath}`
}

function requireMemoryToolModel(adapter: ModelAdapter, modelName: string): Model {
  if (!adapter.agentRuntimeCapabilities.functionTools || !adapter.createAgentModel) {
    throw new Error(`模型 provider '${adapter.provider}' 不支持 SDK 记忆工具运行时`)
  }
  return adapter.createAgentModel(modelName)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

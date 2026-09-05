// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久子运行控制工具
//
//   文件:       durableChildRuns.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import type { ChildRunManager } from '../agent-runtime/children/ChildRunManager.js'
import { deriveJsonSchema } from '../framework/schema.js'
import type {
  ToolContext,
  ToolDef,
  ToolManifestEntry,
  ToolProvider,
  ToolResult,
} from '../framework/types.js'
import { makeId } from '../utils/ids.js'

const childRunIdSchema = z.string().trim().min(1).max(160)
const forkTurnsSchema = z.union([
  z.enum(['none', 'all']),
  z.string().regex(/^[1-9][0-9]{0,3}$/u, '必须是 none、all 或正整数文本'),
])

const spawnSchema = z.object({
  task_name: z.string().trim().regex(/^[a-z0-9_]+$/u).max(80),
  role: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(65_536),
  fork_turns: forkTurnsSchema,
  model: z.string().trim().min(1).max(200).optional(),
  reasoning: z.enum(['none', 'high']).optional(),
  max_model_tokens: z.number().int().positive().max(10_000_000).optional(),
  max_wall_clock_ms: z.number().int().min(1_000).max(86_400_000).optional(),
}).strict()

const listSchema = z.object({
  recursive: z.boolean().default(false),
}).strict()

const targetMessageSchema = z.object({
  child_run_id: childRunIdSchema,
  message: z.string().trim().min(1).max(65_536),
}).strict()

const sendMessageSchema = targetMessageSchema.extend({
  trigger_turn: z.boolean().default(false),
}).strict()

const waitSchema = z.object({
  child_run_ids: z.array(childRunIdSchema).min(1).max(12).optional(),
  after_message_sequence: z.number().int().nonnegative().default(0),
  timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
}).strict()

const targetSchema = z.object({
  child_run_id: childRunIdSchema,
}).strict()

type ToolSpec = {
  entry: ToolManifestEntry
  parameters: z.ZodObject
  prompt: string
  handler: ToolDef['handler']
}

export function createDurableChildRunsProvider(manager: ChildRunManager): ToolProvider {
  const specs: ToolSpec[] = [
    spec({
      name: 'spawn_child_run',
      label: '生成持久子运行',
      description: '在当前根运行预算内创建独立 Thread/Run，并按显式历史范围启动子智能体。',
      parameters: spawnSchema,
      effect: 'world_write',
      replayPolicy: 'idempotency_key',
      prompt: [
        '为一个边界清晰、可以独立完成的任务创建持久 child Run。',
        'task_name 必须是当前父运行下唯一、稳定的小写路径段。',
        'fork_turns 必须明确选择 none、all 或最近 N 个 turn；不要让 child 猜测缺失上下文。',
        '不要用它替代普通平台工具，也不要生成只负责转述同一问题的 child。',
      ].join('\n'),
      handler: async (args, context) => {
        const input = spawnSchema.parse(args)
        const identity = requireAgentControlContext(context)
        const child = await manager.spawn({
          parentRunId: context.runId,
          parentTurnId: identity.turnId,
          rootTurnId: identity.rootTurnId,
          spawnCallId: identity.toolCallId,
          taskName: input.task_name,
          role: input.role,
          message: input.message,
          forkTurns: parseForkTurns(input.fork_turns),
          modelOverride: input.model ?? null,
          reasoningOverride: input.reasoning ?? null,
          maxModelTokens: input.max_model_tokens ?? null,
          maxWallClockMs: input.max_wall_clock_ms ?? null,
          auth: identity.auth,
        })
        return result(`已启动持久子运行“${child.taskName}”。`, { child })
      },
    }),
    spec({
      name: 'list_child_runs',
      label: '列出持久子运行',
      description: '读取当前运行的直接子运行，或读取同一根运行下的完整后代树。',
      parameters: listSchema,
      effect: 'read',
      replayPolicy: 'safe',
      prompt: '读取持久 child Run 的真实状态。需要查看嵌套 child 时才设置 recursive=true。',
      handler: async (args, context) => {
        const input = listSchema.parse(args)
        requireAgentControlContext(context)
        const children = await manager.list(context.runId, input.recursive)
        return result(`已读取 ${children.length} 个持久子运行。`, { children })
      },
    }),
    spec({
      name: 'send_child_input',
      label: '发送子运行输入',
      description: '向同一根运行内的 child 发送持久输入，并在需要时启动或恢复目标 Turn。',
      parameters: targetMessageSchema,
      effect: 'world_write',
      replayPolicy: 'idempotency_key',
      prompt: '仅在目标 child 必须立即继续执行时使用；普通状态同步请使用 send_child_message。',
      handler: async (args, context) => {
        const input = targetMessageSchema.parse(args)
        const identity = requireAgentControlContext(context)
        const message = await manager.sendInput({
          senderRunId: context.runId,
          receiverRunId: input.child_run_id,
          parentTurnId: identity.turnId,
          rootTurnId: identity.rootTurnId,
          messageId: messageId(identity.toolCallId),
          content: input.message,
          auth: identity.auth,
        })
        return result('输入已持久写入目标 child 的 mailbox。', { message })
      },
    }),
    spec({
      name: 'send_child_message',
      label: '发送运行间消息',
      description: '在同一根运行内持久传递消息；默认只排队，不隐式创建新 Turn。',
      parameters: sendMessageSchema,
      effect: 'world_write',
      replayPolicy: 'idempotency_key',
      prompt: [
        '发送状态、证据或协调消息。默认 trigger_turn=false，只写入 mailbox。',
        '只有目标必须立即处理时才设置 trigger_turn=true；不要用轮询消息代替 wait_child_runs。',
      ].join('\n'),
      handler: async (args, context) => {
        const input = sendMessageSchema.parse(args)
        const identity = requireAgentControlContext(context)
        const message = await manager.sendMessage({
          senderRunId: context.runId,
          receiverRunId: input.child_run_id,
          parentTurnId: identity.turnId,
          rootTurnId: identity.rootTurnId,
          messageId: messageId(identity.toolCallId),
          kind: 'message',
          content: input.message,
          triggerTurn: input.trigger_turn,
          auth: identity.auth,
        })
        return result(input.trigger_turn
          ? '消息已持久写入并触发目标 Turn。'
          : '消息已持久排队，未隐式触发目标 Turn。', { message })
      },
    }),
    spec({
      name: 'wait_child_runs',
      label: '等待子运行活动',
      description: '有界等待同一根运行内的 child 终态或发给当前运行的新 mailbox 消息。',
      parameters: waitSchema,
      effect: 'read',
      replayPolicy: 'safe',
      prompt: '需要 child 的新结果时执行有界等待；用 after_message_sequence 避免重复处理旧消息。',
      handler: async (args, context) => {
        const input = waitSchema.parse(args)
        requireAgentControlContext(context)
        const waited = await manager.wait({
          callerRunId: context.runId,
          ...(input.child_run_ids ? { childRunIds: input.child_run_ids } : {}),
          afterMessageSequence: input.after_message_sequence,
          timeoutMs: input.timeout_ms,
          signal: context.signal,
        })
        return result(
          waited.timedOut ? '等待到期，当前没有新的子运行活动。' : '检测到新的子运行活动。',
          { timedOut: waited.timedOut, children: waited.children, messages: waited.messages },
        )
      },
    }),
    spec({
      name: 'interrupt_child_run',
      label: '中断持久子运行',
      description: '只中断同一根运行下的指定 child，不取消父运行或其它 child。',
      parameters: targetSchema,
      effect: 'world_write',
      replayPolicy: 'idempotency_key',
      prompt: '仅当指定 child 的工作已经无效或必须停止时中断它；该操作不会传播到父运行或兄弟运行。',
      handler: async (args, context) => {
        const input = targetSchema.parse(args)
        const identity = requireAgentControlContext(context)
        const child = await manager.interrupt(context.runId, input.child_run_id, identity.auth)
        return result(`子运行“${child.taskName}”已中断。`, { child })
      },
    }),
    spec({
      name: 'resume_child_run',
      label: '恢复持久子运行',
      description: '从持久 checkpoint 独立恢复同一根运行下已中断的 child。',
      parameters: targetSchema,
      effect: 'world_write',
      replayPolicy: 'idempotency_key',
      prompt: '仅恢复 status=interrupted 的 child；恢复会沿用该 child 已持久化的模型、配置与预算。',
      handler: async (args, context) => {
        const input = targetSchema.parse(args)
        const identity = requireAgentControlContext(context)
        const child = await manager.resume(context.runId, input.child_run_id, identity.auth)
        return result(`子运行“${child.taskName}”已从 checkpoint 恢复。`, { child })
      },
    }),
  ]

  return {
    manifest: {
      id: 'durable-child-runs',
      name: '持久子运行控制面',
      version: '1.0.0',
      author: 'Geo Agent Platform',
      description: '根运行预算、持久 child Run 与 mailbox 协作工具。',
      language: 'typescript',
      tools: specs.map(item => item.entry),
    },
    tools: () => specs.map(item => ({
      ...item.entry,
      parameters: item.parameters,
      prompt: item.prompt,
      handler: item.handler,
    })),
  }
}

function spec(input: {
  name: string
  label: string
  description: string
  parameters: z.ZodObject
  effect: 'read' | 'world_write'
  replayPolicy: 'safe' | 'idempotency_key'
  prompt: string
  handler: ToolDef['handler']
}): ToolSpec {
  const readOnly = input.effect === 'read'
  return {
    parameters: input.parameters,
    prompt: input.prompt,
    handler: input.handler,
    entry: {
      name: input.name,
      label: input.label,
      description: input.description,
      group: '智能体协作',
      tags: ['agent', 'child-run', 'durable', 'mailbox'],
      isReadOnly: readOnly,
      isDestructive: false,
      parallelSafe: readOnly,
      requiresApproval: false,
      executionSurfaces: ['agent'],
      agentResultMode: 'continue',
      runtimePolicy: {
        namespace: 'agent-control',
        exposure: 'immediate',
        effect: input.effect,
        parallelism: readOnly ? 'shared' : 'exclusive',
        approvalAction: null,
        replayPolicy: input.replayPolicy,
        requiredCapabilities: [],
      },
      jsonSchema: deriveJsonSchema(input.parameters),
    },
  }
}

function requireAgentControlContext(context: ToolContext): {
  turnId: string
  rootTurnId: string
  toolCallId: string
  auth: NonNullable<ToolContext['auth']>
} {
  if (!context.auth) throw new Error('持久子运行控制需要已认证的执行身份。')
  if (!context.turnId || !context.rootTurnId || !context.toolCallId) {
    throw new Error('持久子运行工具只能从带稳定 Turn/Call 身份的 Agent 执行面调用。')
  }
  return {
    turnId: context.turnId,
    rootTurnId: context.rootTurnId,
    toolCallId: context.toolCallId,
    auth: context.auth,
  }
}

function parseForkTurns(value: z.infer<typeof forkTurnsSchema>): 'none' | 'all' | number {
  return value === 'none' || value === 'all' ? value : Number(value)
}

function messageId(toolCallId: string): string {
  return `agent_message_${toolCallId}`
}

function result(message: string, payload: Record<string, unknown>): ToolResult {
  return {
    message,
    payload,
    warnings: [],
    resultId: makeId('result'),
    source: 'durable-child-runs',
  }
}

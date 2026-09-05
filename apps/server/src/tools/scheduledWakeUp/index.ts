// +-------------------------------------------------------------------------
//
//   地理智能平台 - ScheduledWakeUp 系统工具 Provider
//
//   文件:       index.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'
import manifest from './manifest.json' with { type: 'json' }
import type { ToolDef, ToolProvider, ToolResult } from '../../framework/types.js'
import type { AuthContext } from '../../security/types.js'
import type { ScheduledTaskService } from '../../automations/scheduledTaskService.js'
import { makeId } from '../../utils/ids.js'

const listScheduledTasksManifestTool = manifest.tools.find(tool => tool.name === 'list_scheduled_tasks')
const scheduledWakeUpManifestTool = manifest.tools.find(tool => tool.name === 'ScheduledWakeUp')

const listScheduledTasksArgsSchema = z.object({}).strict()

const scheduledWakeUpArgsSchema = z.object({
  operation: z.enum(['create', 'update', 'delete']),
  taskId: z.string().min(1).optional(),
  targetKind: z.enum(['automation']).optional(),
  targetId: z.string().min(1).optional(),
  title: z.string().optional(),
  prompt: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  recurring: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).strict()

export function createScheduledWakeUpProvider(service: ScheduledTaskService): ToolProvider {
  return {
    manifest,
    tools: (): ToolDef[] => [
      {
        name: 'list_scheduled_tasks',
        label: listScheduledTasksManifestTool?.label ?? '查看定时任务',
        description: listScheduledTasksManifestTool?.description ?? '读取当前工作区的定时任务及其自动化运行记录。',
        prompt: [
          '当用户询问已有定时任务、启用状态或最近自动化运行时，调用 list_scheduled_tasks。',
          '这是只读查询，不会创建、修改、启用或删除任务。',
        ].join('\n'),
        group: listScheduledTasksManifestTool?.group ?? 'system',
        tags: listScheduledTasksManifestTool?.tags ?? ['scheduler', 'automation', 'system'],
        isReadOnly: true,
        isDestructive: false,
        jsonSchema: listScheduledTasksManifestTool?.jsonSchema ?? {},
        parameters: listScheduledTasksArgsSchema,
        handler: async (_args, context) => {
          const auth = requireToolAuth(context.auth)
          const snapshot = await service.listScheduledTasks(auth)
          return success(
            '已读取定时任务列表。',
            { tasks: snapshot.tasks, automationRuns: snapshot.automationRuns },
            'list_scheduled_tasks',
          )
        },
      },
      {
        name: 'ScheduledWakeUp',
        label: scheduledWakeUpManifestTool?.label ?? '管理定时任务',
        description: scheduledWakeUpManifestTool?.description ?? '创建、更新或删除系统定时任务。当前版本支持将自动化流程作为定时目标。',
        prompt: [
          '你可以调用 ScheduledWakeUp 创建、更新或删除系统定时任务。',
          '创建或更新任务前必须确认 cron、timezone、目标 automation 和提示词都明确。',
          '如果用户只是询问已有定时任务，改用只读工具 list_scheduled_tasks。',
          '不要承诺任务已经变更，除非工具结果明确返回成功。',
        ].join('\n'),
        group: scheduledWakeUpManifestTool?.group ?? 'system',
        tags: scheduledWakeUpManifestTool?.tags ?? ['scheduler', 'automation', 'system'],
        isReadOnly: false,
        isDestructive: false,
        requiresApproval: true,
        jsonSchema: scheduledWakeUpManifestTool?.jsonSchema ?? {},
        parameters: scheduledWakeUpArgsSchema,
        handler: async (args, context) => {
          const auth = requireToolAuth(context.auth)
          const parsed = scheduledWakeUpArgsSchema.parse(args)
          if (parsed.operation === 'create') {
            const task = await service.createScheduledTask(auth, {
              targetKind: parsed.targetKind ?? 'automation',
              targetId: requireArg(parsed.targetId, 'targetId'),
              title: parsed.title ?? null,
              prompt: requireArg(parsed.prompt, 'prompt'),
              parameters: parsed.parameters ?? {},
              cron: requireArg(parsed.cron, 'cron'),
              timezone: requireArg(parsed.timezone, 'timezone'),
              recurring: parsed.recurring,
              enabled: parsed.enabled,
            })
            return success('定时任务已创建。', { task }, 'ScheduledWakeUp')
          }
          if (parsed.operation === 'update') {
            const task = await service.updateScheduledTask(auth, requireArg(parsed.taskId, 'taskId'), {
              targetKind: parsed.targetKind,
              targetId: parsed.targetId,
              title: parsed.title,
              prompt: parsed.prompt,
              parameters: parsed.parameters,
              cron: parsed.cron,
              timezone: parsed.timezone,
              recurring: parsed.recurring,
              enabled: parsed.enabled,
            })
            return success('定时任务已更新。', { task }, 'ScheduledWakeUp')
          }
          const task = await service.deleteScheduledTask(auth, requireArg(parsed.taskId, 'taskId'))
          return success('定时任务已删除。', { task }, 'ScheduledWakeUp')
        },
      },
    ],
  }
}

function requireToolAuth(auth: AuthContext | null | undefined): AuthContext {
  if (!auth) throw new Error('ScheduledWakeUp 需要登录用户上下文。')
  return auth
}

function requireArg(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`ScheduledWakeUp 缺少参数 ${name}。`)
  return value.trim()
}

function success(message: string, payload: Record<string, unknown>, source: string): ToolResult {
  return {
    message,
    payload,
    warnings: [],
    resultId: makeId('result'),
    source,
  }
}

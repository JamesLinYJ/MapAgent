// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation WebSocket 命令
//
//   文件:       automationCommands.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 Automation Studio、运行、审批、定时任务和后台任务 WS 命令。

import type { AuthContext } from '../security/types.js'
import type { WsCommandRegistry } from './commandRegistry.js'

export function registerAutomationCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'automation:list',
    handler: (_payload, context) => context.dependencies.automationDefinitionService.list(requireAuth(context.auth)),
  })
  registry.register({
    type: 'automation:validate',
    handler: (payload, context) => context.dependencies.automationDefinitionService.validate(requireAuth(context.auth), payload),
  })
  registry.register({
    type: 'automation:create',
    handler: (payload, context) => context.dependencies.automationDefinitionService.create(requireAuth(context.auth), payload),
  })
  registry.register({
    type: 'automation:update',
    handler: (payload, context) => context.dependencies.automationDefinitionService.saveDraft(
      requireAuth(context.auth),
      payload.automationId,
      payload.expectedRevision,
      payload,
    ),
  })
  registry.register({
    type: 'automation:publish',
    handler: (payload, context) => context.dependencies.automationDefinitionService.publish(
      requireAuth(context.auth),
      payload.automationId,
      payload.revision,
    ),
  })
  registry.register({
    type: 'automation:disable',
    handler: (payload, context) => context.dependencies.automationDefinitionService.disable(requireAuth(context.auth), payload.automationId),
  })
  registry.register({
    type: 'automation:history',
    handler: (payload, context) => context.dependencies.automationDefinitionService.history(requireAuth(context.auth), payload.automationId),
  })
  registry.register({
    type: 'automation:start',
    handler: (payload, context) => context.dependencies.scheduledTaskService.startAutomation(requireAuth(context.auth), payload),
  })
  registry.register({
    type: 'automation:cancel',
    handler: (payload, context) => context.dependencies.scheduledTaskService.cancelAutomation(requireAuth(context.auth), payload.automationRunId),
  })
  registry.register({
    type: 'automation:run:get',
    handler: (payload, context) => context.dependencies.scheduledTaskService.getAutomationRun(
      requireAuth(context.auth),
      payload.automationRunId,
    ),
  })
  registry.register({
    type: 'automation:respond-approval',
    handler: (payload, context) => context.dependencies.scheduledTaskService.respondApproval(
      requireAuth(context.auth),
      payload.automationRunId,
      payload.approvalId,
      payload.decision,
    ),
  })
  registry.register({
    type: 'scheduled-task:list',
    handler: (_payload, context) => context.dependencies.scheduledTaskService.listScheduledTasks(requireAuth(context.auth)),
  })
  registry.register({
    type: 'scheduled-task:create',
    handler: (payload, context) => context.dependencies.scheduledTaskService.createScheduledTask(requireAuth(context.auth), payload),
  })
  registry.register({
    type: 'scheduled-task:update',
    handler: (payload, context) => context.dependencies.scheduledTaskService.updateScheduledTask(requireAuth(context.auth), payload.taskId, payload),
  })
  registry.register({
    type: 'scheduled-task:delete',
    handler: (payload, context) => context.dependencies.scheduledTaskService.deleteScheduledTask(requireAuth(context.auth), payload.taskId),
  })
  registry.register({
    type: 'background-task:list',
    handler: async (_payload, context) => ({ tasks: await context.dependencies.scheduledTaskService.listBackgroundTasks(requireAuth(context.auth)) }),
  })
  registry.register({
    type: 'background-task:promote',
    handler: (payload, context) => context.dependencies.scheduledTaskService.promoteBackgroundTask(requireAuth(context.auth), payload.taskId),
  })
  registry.register({
    type: 'background-task:cancel',
    handler: (payload, context) => context.dependencies.scheduledTaskService.cancelBackgroundTask(requireAuth(context.auth), payload.taskId),
  })
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 命令注册表
//
//   文件:       commandRegistry.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-08-31):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 以共享命令契约作为唯一协议事实源，并为写命令接入有界互斥调度。
// --------------------------------------------------------------------------

import {
  wsCommandContract,
  type WsControlCommand,
  type WsCommandPayload,
  type WsWriteCommand,
} from '@geo-agent-platform/shared-types'
import type { WebSocket } from 'ws'

import type { OpenAIAgentsRuntime } from '../agent/runtime.js'
import type { RunTaskManager } from '../agent/runTaskManager.js'
import type { AuthContext } from '../security/types.js'
import type { RuntimeFileStore } from '../store/fileStore.js'
import {
  ControlMutationScheduler,
  type ScheduleControlMutation,
} from './ControlMutationScheduler.js'
import type { WsDependencies } from './dependencies.js'
import type { ClientMsg } from './protocol.js'

export interface WsCommandContext {
  msg: ClientMsg
  dependencies: WsDependencies
  runtime: OpenAIAgentsRuntime
  runTasks: RunTaskManager
  files: RuntimeFileStore
  ws: WebSocket
  subscriptions: Map<string, () => void>
  auth: AuthContext | null
  connectionId: string
  connectionSignal?: AbortSignal
  controlSignal?: AbortSignal
  setResponseDelivery(deliver: (message: string) => void): void
}

export type WsCommandAuthorization = (
  payload: Record<string, unknown>,
  context: WsCommandContext,
) => Promise<void> | void

export type MutationResourceResolver = (
  payload: Record<string, unknown>,
  context: WsCommandContext,
) => readonly string[]

export interface WsCommandRegistration<K extends WsControlCommand> {
  type: K
  handler(
    payload: WsCommandPayload<K>,
    context: WsCommandContext,
  ): Promise<unknown> | unknown
}

export interface RegisteredWsCommand {
  type: WsControlCommand
  auth: 'required' | 'optional'
  csrf: boolean
  category: 'read' | 'write' | 'admin'
  authorize?: WsCommandAuthorization
}

interface StoredWsCommand extends RegisteredWsCommand {
  mutationResources?: MutationResourceResolver
  parsePayload(payload: unknown): unknown
  parseResponse(response: unknown): unknown
  handler(payload: unknown, context: WsCommandContext): Promise<unknown> | unknown
}

/**
 * WS 控制面的唯一命令注册入口。注册方只提供命令名和 handler；
 * payload、response、鉴权与命令类别全部由 shared-types 契约派生。
 */
export class WsCommandRegistry {
  private readonly commands = new Map<WsControlCommand, StoredWsCommand>()

  constructor(private readonly mutationScheduler = new ControlMutationScheduler()) {}

  register<K extends WsControlCommand>(definition: WsCommandRegistration<K>): void {
    if (this.commands.has(definition.type)) {
      throw new Error(`WS 命令 '${definition.type}' 重复注册`)
    }
    const contract = wsCommandContract(definition.type)
    this.commands.set(definition.type, {
      type: definition.type,
      auth: contract.auth,
      csrf: contract.csrf,
      category: contract.category,
      parsePayload: payload => contract.payload.parse(payload),
      parseResponse: response => contract.response.parse(response),
      handler: (payload, context) => definition.handler(
        payload as WsCommandPayload<K>,
        context,
      ),
    })
  }

  get(type: WsControlCommand): RegisteredWsCommand | null {
    return this.commands.get(type) ?? null
  }

  setAuthorize(type: WsControlCommand, authorize: WsCommandAuthorization): void {
    const definition = this.require(type)
    definition.authorize = authorize
  }

  setMutationResources(type: WsWriteCommand, resolver: MutationResourceResolver): void {
    const definition = this.require(type)
    if (definition.category !== 'write') {
      throw new Error(`WS 命令 '${type}' 不是写命令，不能挂载变更资源键。`)
    }
    definition.mutationResources = resolver
  }

  cancelConnection(connectionId: string): void {
    this.mutationScheduler.cancelConnection(connectionId)
  }

  async execute(msg: ClientMsg, context: Omit<WsCommandContext, 'msg'>): Promise<unknown> {
    const definition = this.require(msg.type)
    if (definition.auth === 'required' && !context.auth) {
      throw new Error('WebSocket 命令需要登录。')
    }
    const parsedPayload = definition.parsePayload(msg.payload)
    const recordPayload = requireRecordPayload(parsedPayload, msg.type)
    const commandContext: WsCommandContext = { ...context, msg }
    const authorize = definition.authorize
    if (!authorize) throw new Error(`WS 命令 '${msg.type}' 缺少授权策略。`)

    // 先鉴权再入队，避免无权请求占用有界队列。
    await authorize(recordPayload, commandContext)
    if (definition.category !== 'write') {
      return definition.parseResponse(await definition.handler(parsedPayload, commandContext))
    }

    const resolveResources = definition.mutationResources
    if (!resolveResources) throw new Error(`WS 写命令 '${msg.type}' 缺少变更资源键。`)
    const schedule: ScheduleControlMutation<unknown> = {
      connectionId: context.connectionId,
      resourceKeys: resolveResources(recordPayload, commandContext),
      ...(context.connectionSignal ? { signal: context.connectionSignal } : {}),
      // 排队期间会话、角色或资源可能变化，handler 前必须重验。
      reauthorize: () => authorize(recordPayload, commandContext),
      execute: async controlSignal => definition.parseResponse(await definition.handler(
        parsedPayload,
        { ...commandContext, controlSignal },
      )),
    }
    return this.mutationScheduler.schedule(schedule)
  }

  registeredTypes(): WsControlCommand[] {
    return [...this.commands.keys()]
  }

  commandsWithoutAuthorization(): WsControlCommand[] {
    return [...this.commands.values()]
      .filter(definition => !definition.authorize)
      .map(definition => definition.type)
  }

  writeCommandsWithoutMutationResources(): WsWriteCommand[] {
    return [...this.commands.values()]
      .filter((definition): definition is StoredWsCommand & { type: WsWriteCommand } => (
        definition.category === 'write' && !definition.mutationResources
      ))
      .map(definition => definition.type)
  }

  private require(type: WsControlCommand): StoredWsCommand {
    const definition = this.commands.get(type)
    if (!definition) throw new Error(`WS 命令 '${type}' 尚未注册`)
    return definition
  }
}

function requireRecordPayload(payload: unknown, type: WsControlCommand): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`WS 命令 '${type}' payload 必须是对象。`)
  }
  return payload as Record<string, unknown>
}

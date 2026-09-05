// +-------------------------------------------------------------------------
//
//   地理智能平台 - 受信任 Runtime Hook 注册表
//
//   文件:       RuntimeHookRegistry.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  runtimeHookOutputSchema,
  type HookConfigEntry,
  type RuntimeHookEvent,
  type RuntimeHookOutput,
} from '@geo-agent-platform/shared-types/runtime'

export interface RuntimeHookPayload {
  runId: string
  turnId: string | null
  stepId: string | null
  eventType: RuntimeHookEvent
  attributes: Readonly<Record<string, string>>
  toolName?: string
  toolInput?: Readonly<Record<string, unknown>>
  approvalRequired?: boolean
}

export interface RuntimeHookHandler {
  hookId: string
  eventTypes: readonly RuntimeHookEvent[]
  source: 'platform' | 'plugin'
  execute(payload: RuntimeHookPayload, signal: AbortSignal): Promise<RuntimeHookOutput | unknown>
}

export interface RuntimeHookRunOptions {
  risk?: 'normal' | 'high'
  signal?: AbortSignal
  validateUpdatedToolInput?: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>
  authorizeUpdatedToolInput?: (
    input: Readonly<Record<string, unknown>>,
  ) => Promise<void> | void
  policyAllowsApproval?: boolean
}

interface RuntimeHookAuditEntry {
  hookId: string
  eventType: RuntimeHookEvent
  source: RuntimeHookHandler['source']
  status: 'continued' | 'blocked' | 'failed_open'
  durationMs: number
  reason: string | null
}

export interface RuntimeHookRunResult {
  additionalContext: string[]
  toolInput: Record<string, unknown> | null
  approvalDecision: 'approve' | 'deny' | 'defer' | null
  audit: RuntimeHookAuditEntry[]
}

export class RuntimeHookBlockedError extends Error {
  constructor(
    message: string,
    readonly hookId: string,
    readonly eventType: RuntimeHookEvent,
  ) {
    super(message)
    this.name = 'RuntimeHookBlockedError'
  }
}

/**
 * Registry 只接受宿主显式注入的 handler；配置只能按 ID 选择它们。Hook 的
 * input rewrite 在返回调用者前完成 schema + policy 双重重校验，无法直接改写
 * ToolRouter、ApprovalPolicy 或 StepContext。
 */
export class RuntimeHookRegistry {
  private readonly handlers = new Map<string, RuntimeHookHandler>()

  constructor(handlers: readonly RuntimeHookHandler[]) {
    for (const handler of handlers) {
      if (this.handlers.has(handler.hookId)) {
        throw new Error(`Runtime Hook '${handler.hookId}' 重复注册`)
      }
      this.handlers.set(handler.hookId, handler)
    }
  }

  bind(configs: readonly HookConfigEntry[]): RuntimeHookSession {
    const bindings = configs
      .filter(config => config.enabled)
      .map(config => {
        const handler = this.handlers.get(config.hookId)
        if (!handler) throw new Error(`Runtime Hook '${config.hookId}' 未显式注册`)
        if (!handler.eventTypes.includes(config.eventType)) {
          throw new Error(`Runtime Hook '${config.hookId}' 未声明事件 '${config.eventType}'`)
        }
        return { config, handler }
      })
      .sort((left, right) => (
        right.config.priority - left.config.priority
        || left.config.hookId.localeCompare(right.config.hookId)
      ))
    return new RuntimeHookSession(bindings)
  }
}

interface RuntimeHookBinding {
  config: HookConfigEntry
  handler: RuntimeHookHandler
}

export class RuntimeHookSession {
  constructor(private readonly bindings: readonly RuntimeHookBinding[]) {}

  async run(
    payload: RuntimeHookPayload,
    options: RuntimeHookRunOptions = {},
  ): Promise<RuntimeHookRunResult> {
    const additionalContext: string[] = []
    const audit: RuntimeHookAuditEntry[] = []
    let toolInput = payload.toolInput ? structuredClone(payload.toolInput) : null
    let approvalDecision: RuntimeHookRunResult['approvalDecision'] = null

    for (const binding of this.bindings) {
      if (binding.config.eventType !== payload.eventType) continue
      if (!matches(binding.config.matcher, payload.attributes)) continue
      const startedAt = Date.now()
      let output: RuntimeHookOutput
      try {
        output = runtimeHookOutputSchema.parse(await executeWithTimeout(
          binding.handler,
          { ...payload, ...(toolInput ? { toolInput } : {}) },
          binding.config.timeoutMs,
          options.signal,
        ))
      } catch (error) {
        const reason = redactSensitive(errorMessage(error))
        const failClosed = options.risk === 'high' || binding.config.failureMode === 'fail_closed'
        audit.push({
          hookId: binding.config.hookId,
          eventType: payload.eventType,
          source: binding.handler.source,
          status: failClosed ? 'blocked' : 'failed_open',
          durationMs: Date.now() - startedAt,
          reason,
        })
        if (failClosed) {
          throw new RuntimeHookBlockedError(
            `Runtime Hook '${binding.config.hookId}' 执行失败：${reason}`,
            binding.config.hookId,
            payload.eventType,
          )
        }
        continue
      }

      if (output.decision === 'block') {
        const reason = redactSensitive(output.reason ?? 'Hook 阻断了当前操作')
        audit.push({
          hookId: binding.config.hookId,
          eventType: payload.eventType,
          source: binding.handler.source,
          status: 'blocked',
          durationMs: Date.now() - startedAt,
          reason,
        })
        throw new RuntimeHookBlockedError(reason, binding.config.hookId, payload.eventType)
      }
      if (output.additionalContext) additionalContext.push(redactSensitive(output.additionalContext))
      if (output.updatedToolInput) {
        if (payload.eventType !== 'PreToolUse') {
          throw contractViolation(binding, payload, '只有 PreToolUse Hook 可以更新工具输入')
        }
        if (!options.validateUpdatedToolInput || !options.authorizeUpdatedToolInput) {
          throw contractViolation(binding, payload, '工具输入更新缺少 schema 或 policy 重校验器')
        }
        try {
          const validated = await options.validateUpdatedToolInput(output.updatedToolInput)
          await options.authorizeUpdatedToolInput(validated)
          toolInput = structuredClone(validated)
        } catch (error) {
          throw contractViolation(
            binding,
            payload,
            `工具输入重校验失败：${redactSensitive(errorMessage(error))}`,
          )
        }
      }
      if (output.approvalDecision) {
        if (payload.eventType !== 'PermissionRequest') {
          throw contractViolation(binding, payload, '只有 PermissionRequest Hook 可以返回审批决策')
        }
        if (output.approvalDecision === 'approve' && options.policyAllowsApproval !== true) {
          throw contractViolation(binding, payload, 'Hook 审批不能越过平台策略')
        }
        approvalDecision = output.approvalDecision
      }
      audit.push({
        hookId: binding.config.hookId,
        eventType: payload.eventType,
        source: binding.handler.source,
        status: 'continued',
        durationMs: Date.now() - startedAt,
        reason: null,
      })
    }

    return { additionalContext, toolInput, approvalDecision, audit }
  }
}

async function executeWithTimeout(
  handler: RuntimeHookHandler,
  payload: RuntimeHookPayload,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<unknown> {
  if (parentSignal?.aborted) {
    throw parentSignal.reason instanceof Error
      ? parentSignal.reason
      : new Error('Hook 执行已取消')
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', abort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`Hook 超过 ${timeoutMs}ms`))
        reject(new Error(`Hook 超过 ${timeoutMs}ms`))
      }, timeoutMs)
    })
    return await Promise.race([
      handler.execute(payload, controller.signal),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
    parentSignal?.removeEventListener('abort', abort)
  }
}

function contractViolation(
  binding: RuntimeHookBinding,
  payload: RuntimeHookPayload,
  reason: string,
): RuntimeHookBlockedError {
  return new RuntimeHookBlockedError(
    `Runtime Hook '${binding.config.hookId}' 合同违规：${reason}`,
    binding.config.hookId,
    payload.eventType,
  )
}

function matches(
  matcher: Readonly<Record<string, string>>,
  attributes: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(matcher).every(([key, value]) => attributes[key] === value)
}

function redactSensitive(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, 'sk-[REDACTED]')
    .replace(/\b(token|secret|password)=([^\s&]+)/giu, '$1=[REDACTED]')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

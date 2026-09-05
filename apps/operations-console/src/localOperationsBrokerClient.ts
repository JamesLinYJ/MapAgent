// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机运维 Broker 客户端
//
//   文件:       localOperationsBrokerClient.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'

import {
  localAccountListResultSchema,
  localAccountResultSchema,
  localAgentAuthorizationSchema,
  localAuditListResultSchema,
  localOperationsResponseSchema,
  type LocalAgentAuthorization,
  type LocalOperationsRequest,
} from '@geo-agent-platform/shared-types/local-operations'
import { projectSupervisorEnvironment } from '@geo-agent-platform/operations-supervisor/environment'
import type { z } from 'zod'

import type { LocalConsoleDataPlane } from './localConsoleTypes.js'

interface PendingResponse {
  resolve(value: unknown): void
  reject(error: Error): void
}

interface PendingAuthorization {
  resolve(value: LocalAgentAuthorization): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

const BROKER_STDERR_BUFFER_CHARS = 8_192
const BROKER_STDERR_REPORT_CHARS = 2_048

type LocalOperationsRequestInput = LocalOperationsRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, 'id'>
    : never
  : never

export class LocalOperationsBrokerClient {
  private readonly pending = new Map<string, PendingResponse>()
  private readonly authorizationWaiters = new Set<PendingAuthorization>()
  private readonly child: ChildProcessWithoutNullStreams
  private authorization: LocalAgentAuthorization | null = null
  private terminalError: Error | null = null
  private stderr = ''
  private closed = false

  private constructor(projectRoot: string, mode: 'accounts' | 'agent') {
    const entry = path.join(
      projectRoot,
      'apps',
      'server',
      'dist',
      'operations',
      'localOperationsBrokerEntry.js',
    )
    this.child = spawn(process.execPath, [entry, mode], {
      cwd: projectRoot,
      env: createLocalOperationsBrokerEnvironment(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-BROKER_STDERR_BUFFER_CHARS)
    })
    this.child.once('error', error => this.failAll(new Error(
      `本机运维 Broker 启动失败：${safeBrokerDiagnostic(error.message) || '未知子进程错误'}`,
      { cause: error },
    )))
    this.child.once('exit', (code, signal) => {
      if (!this.closed || code !== 0) {
        const diagnostic = safeBrokerDiagnostic(this.stderr)
        this.failAll(new Error(
          `本机运维 Broker 已退出（${code ?? signal ?? 'signal'}）${diagnostic ? `：${diagnostic}` : ''}`,
        ))
      }
    })
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
    lines.on('line', line => this.receive(line))
  }

  static open(projectRoot: string, mode: 'accounts' | 'agent'): LocalOperationsBrokerClient {
    return new LocalOperationsBrokerClient(projectRoot, mode)
  }

  async waitForAgentAuthorization(timeoutMs = 15_000): Promise<LocalAgentAuthorization> {
    if (this.terminalError) throw this.terminalError
    if (this.authorization) return this.authorization
    if (this.closed) throw new Error('本机运维 Broker 已关闭。')
    return new Promise((resolve, reject) => {
      const waiter: PendingAuthorization = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.authorizationWaiters.delete(waiter)
          reject(new Error('本机 Agent Broker 授权超时。'))
        }, timeoutMs),
      }
      this.authorizationWaiters.add(waiter)
    })
  }

  async accountDataPlane(): Promise<LocalConsoleDataPlane> {
    return {
      accounts: {
        listAccounts: () => this.request({ operation: 'accounts.list' }, localAccountListResultSchema),
        createPlatformAdmin: input => this.request({
          operation: 'accounts.createPlatformAdmin',
          input,
        }, localAccountResultSchema),
        grantPlatformAdmin: email => this.request({
          operation: 'accounts.grantPlatformAdmin',
          email,
        }, localAccountResultSchema),
        revokePlatformAdmin: email => this.request({
          operation: 'accounts.revokePlatformAdmin',
          email,
        }, localAccountResultSchema),
        setAccountEnabled: (email, enabled) => this.request({
          operation: 'accounts.setEnabled',
          email,
          enabled,
        }, localAccountResultSchema),
        resetPassword: async (email, password) => {
          await this.request({ operation: 'accounts.resetPassword', email, password })
        },
        revokeSessions: async email => {
          await this.request({ operation: 'accounts.revokeSessions', email })
        },
      },
      listAuditEvents: (limit = 300) => this.request({
        operation: 'audit.list',
        limit,
      }, localAuditListResultSchema),
      close: () => this.close(),
    }
  }

  request<T>(
    request: LocalOperationsRequestInput,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('本机运维 Broker 已关闭。'))
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => {
          try {
            resolve(schema ? schema.parse(value) : value as T)
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        },
        reject,
      })
      this.child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, error => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  async closeAgent(input: {
    runId: string | null
    threadId: string | null
    outcome: 'allowed' | 'error'
  }): Promise<void> {
    await this.request({ operation: 'agent.close', ...input })
    await this.close()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.child.stdin.end()
    if (this.child.exitCode === null) {
      await new Promise<void>(resolve => this.child.once('exit', () => resolve()))
    }
  }

  private receive(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.failAll(new Error('本机运维 Broker 返回了无效 JSON。'))
      return
    }
    const authorization = localAgentAuthorizationSchema.safeParse(value)
    if (authorization.success) {
      this.authorization = authorization.data
      for (const waiter of this.authorizationWaiters) {
        clearTimeout(waiter.timer)
        waiter.resolve(authorization.data)
      }
      this.authorizationWaiters.clear()
      return
    }
    const response = localOperationsResponseSchema.parse(value)
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(new Error(response.error ?? '本机运维 Broker 请求失败。'))
  }

  private failAll(error: Error): void {
    this.terminalError ??= error
    for (const waiter of this.authorizationWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(this.terminalError)
    }
    this.authorizationWaiters.clear()
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

/** Broker 仅继承已声明的本机服务字段，不接收完整宿主环境。 */
export function createLocalOperationsBrokerEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return projectSupervisorEnvironment(source)
}

function safeBrokerDiagnostic(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '�')
    .trim()
    .slice(-BROKER_STDERR_REPORT_CHARS)
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机运维特权进程边界
//
//   文件:       localOperationsBrokerEntry.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import {
  localOperationsRequestSchema,
  type LocalOperationsRequest,
} from '@geo-agent-platform/shared-types/local-operations'
import {
  assertProductionSecretPermissions,
  ensureSecretFile,
  resolveOperationsPaths,
} from '@geo-agent-platform/operations-supervisor'
import type { OperationsProfile } from '@geo-agent-platform/shared-types/operations'
import { config as loadDotEnv } from 'dotenv'

import { createDb } from '../db/connection.js'
import { verifyDatabaseSchemaContract } from '../db/schemaContract.js'
import { parseEnv } from '../framework/env.js'
import { BetterAuthService } from '../security/authService.js'
import { ensureSecurityTables } from '../security/database.js'
import { deriveLocalConsoleCredential } from '../security/localConsolePrincipal.js'
import { PlatformIdentityService } from '../security/platformIdentityService.js'
import { AuditStore } from '../store/postgres/auditStore.js'
import { AuthSessionRepository } from '../store/postgres/authSessionRepository.js'
import { LocalAccountRepository } from '../store/postgres/localAccountRepository.js'
import { MembershipRepository } from '../store/postgres/membershipRepository.js'
import { PlatformUserRepository } from '../store/postgres/platformUserRepository.js'
import { WorkspaceRepository } from '../store/postgres/workspaceRepository.js'
import { LocalAccountService } from './localAccountService.js'

type BrokerMode = 'accounts' | 'agent' | 'desktop'

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2))
  const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  loadDotEnv({ path: path.join(projectRoot, '.env'), quiet: true })
  const serviceEnvironmentFile = process.env.GEO_AGENT_PLATFORM_SERVICE_ENV_FILE?.trim()
  if (serviceEnvironmentFile) {
    if (!path.isAbsolute(serviceEnvironmentFile)) {
      throw new Error('GEO_AGENT_PLATFORM_SERVICE_ENV_FILE 必须是绝对路径。')
    }
    loadDotEnv({ path: serviceEnvironmentFile, override: true, quiet: true })
  }
  const env = parseEnv(process.env)
  const profile: OperationsProfile = process.env.NODE_ENV === 'production' ? 'production' : 'development'
  const paths = await resolveOperationsPaths({
    projectRoot,
    profile,
    ...(process.env.RUNTIME_ROOT ? { runtimeRoot: path.resolve(projectRoot, process.env.RUNTIME_ROOT) } : {}),
    ...(process.env.GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE
      ? { rootSecretFile: path.resolve(projectRoot, process.env.GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE) }
      : {}),
  })
  const rootSecret = await ensureSecretFile(paths.rootSecretFile, profile === 'development')
  if (profile === 'production') await assertProductionSecretPermissions(paths.rootSecretFile)

  const db = createDb(env.DATABASE_URL)
  try {
    await verifyDatabaseSchemaContract(db)
    await ensureSecurityTables(db)
    const users = new PlatformUserRepository(db)
    const memberships = new MembershipRepository(db)
    const workspaces = new WorkspaceRepository(db)
    const identity = new PlatformIdentityService({
      db,
      users,
      workspaces,
      memberships,
      authSessions: new AuthSessionRepository(db),
    })
    const auth = new BetterAuthService({ db, env, identity })
    const audit = new AuditStore(db)
    if (mode === 'accounts') {
      const credential = deriveLocalConsoleCredential(rootSecret)
      await serveAccountRequests(new LocalAccountService({
        db,
        auth,
        identity,
        accounts: new LocalAccountRepository(db),
        users,
        workspaces,
        memberships,
        audit,
        actor: localActor(),
        rootSecret,
        rootKeyVersion: credential.keyVersion,
        minPasswordLength: env.BETTER_AUTH_MIN_PASSWORD_LENGTH,
      }), audit)
      return
    }
    const authorizationInput = {
      auth,
      audit,
      rootSecret,
      appBaseUrl: localApiEndpoint(env.API_PORT),
      origin: new URL(env.APP_BASE_URL).origin,
    }
    if (mode === 'agent') {
      await serveAgentAuthorization(authorizationInput)
    } else {
      await serveDesktopAuthorization(authorizationInput)
    }
  } finally {
    await db.close()
  }
}

async function serveAccountRequests(
  accounts: LocalAccountService,
  audit: AuditStore,
): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (!line.trim()) continue
    let requestId = 'invalid'
    try {
      const request = localOperationsRequestSchema.parse(JSON.parse(line))
      requestId = request.id
      const result = await executeAccountRequest(request, accounts, audit)
      writeResponse({ id: request.id, ok: true, result })
    } catch (error) {
      writeResponse({ id: requestId, ok: false, error: errorMessage(error) })
    }
  }
}

async function executeAccountRequest(
  request: LocalOperationsRequest,
  accounts: LocalAccountService,
  audit: AuditStore,
): Promise<unknown> {
  switch (request.operation) {
    case 'accounts.list':
      return accounts.listAccounts()
    case 'accounts.createPlatformAdmin':
      return accounts.createPlatformAdmin(request.input)
    case 'accounts.grantPlatformAdmin':
      return accounts.grantPlatformAdmin(request.email)
    case 'accounts.revokePlatformAdmin':
      return accounts.revokePlatformAdmin(request.email)
    case 'accounts.setEnabled':
      return accounts.setAccountEnabled(request.email, request.enabled)
    case 'accounts.resetPassword':
      await accounts.resetPassword(request.email, request.password)
      return null
    case 'accounts.revokeSessions':
      await accounts.revokeSessions(request.email)
      return null
    case 'audit.list':
      return audit.listRecent(request.limit)
    case 'agent.close':
      throw new Error('账户 Broker 不接受 Agent 关闭命令。')
    case 'desktop.close':
      throw new Error('账户 Broker 不接受 Desktop 关闭命令。')
  }
}

async function serveAgentAuthorization(input: {
  auth: BetterAuthService
  audit: AuditStore
  rootSecret: string
  appBaseUrl: string
  origin: string
}): Promise<void> {
  await input.auth.withLocalAgentAuthorization(input.rootSecret, async authorization => {
    const actor = {
      ...localActor(),
      keyVersion: authorization.keyVersion,
      transport: 'loopback_websocket',
    }
    await input.audit.recordEvent({
      actorUserId: authorization.authContext.userId,
      workspaceId: authorization.authContext.defaultWorkspaceId,
      action: 'local_agent.session.open',
      objectType: 'system',
      objectId: null,
      outcome: 'allowed',
      metadata: actor,
    })
    const cookie = authorization.headers.get('cookie')
    if (!cookie) throw new Error('本机 Agent 授权未生成 Cookie。')
    process.stdout.write(`${JSON.stringify({
      type: 'agent.authorization',
      appBaseUrl: input.appBaseUrl,
      origin: input.origin,
      cookie,
      csrfToken: authorization.authContext.csrfToken,
      actor,
    })}\n`)

    let closeRequest: Extract<LocalOperationsRequest, { operation: 'agent.close' }> | null = null
    const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
    for await (const line of lines) {
      if (!line.trim()) continue
      const request = localOperationsRequestSchema.parse(JSON.parse(line))
      if (request.operation !== 'agent.close') {
        writeResponse({ id: request.id, ok: false, error: 'Agent Broker 只接受关闭命令。' })
        continue
      }
      closeRequest = request
      writeResponse({ id: request.id, ok: true, result: null })
      break
    }
    const outcome = closeRequest?.outcome ?? 'error'
    await input.audit.recordEvent({
      actorUserId: authorization.authContext.userId,
      workspaceId: authorization.authContext.defaultWorkspaceId,
      action: 'local_agent.session.close',
      objectType: 'system',
      objectId: closeRequest?.runId ?? null,
      outcome,
      metadata: {
        ...actor,
        threadId: closeRequest?.threadId ?? null,
        runId: closeRequest?.runId ?? null,
      },
    })
  })
}

async function serveDesktopAuthorization(input: {
  auth: BetterAuthService
  audit: AuditStore
  rootSecret: string
  appBaseUrl: string
  origin: string
}): Promise<void> {
  const parentPort = requireDesktopParentPort()
  await input.auth.withLocalDesktopAuthorization(input.rootSecret, async authorization => {
    const actor = {
      ...localActor(),
      keyVersion: authorization.keyVersion,
      transport: 'electron_main',
    }
    await input.audit.recordEvent({
      actorUserId: authorization.authContext.userId,
      workspaceId: authorization.authContext.defaultWorkspaceId,
      action: 'local_desktop.session.open',
      objectType: 'system',
      objectId: null,
      outcome: 'allowed',
      metadata: actor,
    })
    const cookie = authorization.headers.get('cookie')
    if (!cookie) throw new Error('本机 Desktop 授权未生成 Cookie。')
    parentPort.postMessage({
      type: 'desktop.authorization',
      appBaseUrl: input.appBaseUrl,
      origin: input.origin,
      cookie,
      csrfToken: authorization.authContext.csrfToken,
      actor,
    })

    const closeRequest = await waitForDesktopCloseRequest(parentPort)
    await input.audit.recordEvent({
      actorUserId: authorization.authContext.userId,
      workspaceId: authorization.authContext.defaultWorkspaceId,
      action: 'local_desktop.session.close',
      objectType: 'system',
      objectId: null,
      outcome: closeRequest.outcome,
      metadata: actor,
    })
  })
}

interface DesktopParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  off(event: 'message', listener: (event: { data: unknown }) => void): void
}

function requireDesktopParentPort(): DesktopParentPort {
  const parentPort = (process as NodeJS.Process & {
    parentPort?: DesktopParentPort | null
  }).parentPort
  if (!parentPort) {
    throw new Error('Desktop Broker 必须由 Electron utilityProcess 启动。')
  }
  return parentPort
}

function waitForDesktopCloseRequest(
  parentPort: DesktopParentPort,
): Promise<Extract<LocalOperationsRequest, { operation: 'desktop.close' }>> {
  return new Promise(resolve => {
    const handleMessage = (event: { data: unknown }) => {
      const parsed = localOperationsRequestSchema.safeParse(event.data)
      if (!parsed.success) {
        parentPort.postMessage({
          id: requestId(event.data),
          ok: false,
          error: `Desktop Broker 收到无效命令：${parsed.error.issues[0]?.message ?? '结构不匹配'}`,
        })
        return
      }
      if (parsed.data.operation !== 'desktop.close') {
        parentPort.postMessage({
          id: parsed.data.id,
          ok: false,
          error: 'Desktop Broker 只接受关闭命令。',
        })
        return
      }
      parentPort.off('message', handleMessage)
      parentPort.postMessage({ id: parsed.data.id, ok: true, result: null })
      resolve(parsed.data)
    }
    parentPort.on('message', handleMessage)
  })
}

function requestId(value: unknown): string {
  return value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
    ? value.id
    : 'invalid'
}

function parseMode(args: readonly string[]): BrokerMode {
  const mode = args[0]
  if (mode !== 'accounts' && mode !== 'agent' && mode !== 'desktop') {
    throw new Error('Broker 模式必须是 accounts、agent 或 desktop。')
  }
  return mode
}

function localActor() {
  return {
    osUser: localUserName(),
    hostname: os.hostname(),
    processId: process.pid,
  }
}

function localUserName(): string {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? 'unknown'
  }
}

function localApiEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`
}

function writeResponse(response: {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}): void {
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

main().catch(error => {
  process.stderr.write(`平台 本机运维 Broker 启动失败：${errorMessage(error)}\n`)
  process.exitCode = 1
})

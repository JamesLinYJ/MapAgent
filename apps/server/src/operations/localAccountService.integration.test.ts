// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本地账户管理真实数据库集成测试
//
//   文件:       localAccountService.integration.test.ts
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import os from 'node:os'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDb, type Database } from '../db/connection.js'
import { parseEnv, type Env } from '../framework/env.js'
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

const databaseUrl = process.env.GEO_AGENT_PLATFORM_LOCAL_CONSOLE_TEST_DATABASE_URL
const describeIntegration = databaseUrl ? describe : describe.skip

describeIntegration('LocalAccountService with Better Auth Admin Plugin', () => {
  let db: Database
  let env: Env
  let accounts: LocalAccountService
  let accountRepository: LocalAccountRepository
  let auth: BetterAuthService
  const rootSecret = 'integration-local-root-secret-at-least-32-bytes'

  beforeAll(async () => {
    env = parseEnv({
      API_PORT: '18000',
      API_HOST: '127.0.0.1',
      DATABASE_URL: databaseUrl,
      RUNTIME_ROOT: './runtime/integration-test',
      APP_BASE_URL: 'http://127.0.0.1:18000',
      BETTER_AUTH_URL: 'http://127.0.0.1:18000',
      BETTER_AUTH_SECRET: 'integration-only-better-auth-secret-change-before-production',
      BETTER_AUTH_ALLOW_SIGN_UP: 'false',
      BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
      BETTER_AUTH_MIN_PASSWORD_LENGTH: '12',
      ENABLED_TOOL_PROVIDERS: 'geo-platform-plan',
    })
    db = createDb(env.DATABASE_URL)
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
    auth = new BetterAuthService({ db, env, identity })
    accountRepository = new LocalAccountRepository(db)
    accounts = new LocalAccountService({
      db,
      auth,
      identity,
      accounts: accountRepository,
      users,
      workspaces,
      memberships,
      audit: new AuditStore(db),
      actor: { osUser: os.userInfo().username, hostname: os.hostname(), processId: process.pid },
      rootSecret,
      rootKeyVersion: deriveLocalConsoleCredential(rootSecret).keyVersion,
      minPasswordLength: env.BETTER_AUTH_MIN_PASSWORD_LENGTH,
    })
  })

  afterAll(async () => {
    await db?.close()
  })

  it('executes the complete local administrator lifecycle through official SDK APIs', async () => {
    const operatorPassword = 'operator-password-2026'
    const targetPassword = 'target-password-2026'
    const replacementPassword = 'replacement-password-2026'
    await accounts.createPlatformAdmin({
      email: 'operator@example.test',
      displayName: '集成测试操作员',
      password: operatorPassword,
    })
    await accounts.createPlatformAdmin({
      email: 'target@example.test',
      displayName: '集成测试目标',
      password: targetPassword,
    })
    await expect(accountRepository.countActivePlatformAdmins()).resolves.toBe(2)

    await accounts.resetPassword('target@example.test', replacementPassword)
    await expect(signInStatus(auth, 'target@example.test', replacementPassword)).resolves.toBe(200)

    await accounts.setAccountEnabled('target@example.test', false)
    await expect(accountRepository.countActivePlatformAdmins()).resolves.toBe(1)
    await expect(signInStatus(auth, 'target@example.test', replacementPassword)).resolves.not.toBe(200)
    await accounts.setAccountEnabled('target@example.test', true)
    await expect(accountRepository.countActivePlatformAdmins()).resolves.toBe(2)
    const revoked = await accounts.revokePlatformAdmin('target@example.test')

    expect(revoked.authRole).toBe('user')
    expect(revoked.platformRoles.some(binding => binding.role === 'platform_admin')).toBe(false)
    await expect(accountRepository.countActivePlatformAdmins()).resolves.toBe(1)
    await expect(signInStatus(auth, 'target@example.test', replacementPassword)).resolves.toBe(200)
    expect((await accountRepository.list()).every(account => !account.email.endsWith('@console.geo-agent-platform.invalid'))).toBe(true)

    const events = await new AuditStore(db).listRecent()
    expect(events.map(event => event.action)).toEqual(expect.arrayContaining([
      'local_console.admin.create',
      'local_console.account.password_reset',
      'local_console.account.disable',
      'local_console.account.enable',
      'local_console.admin.revoke',
    ]))
  }, 30_000)

  it('creates a hidden Agent principal that only authenticates through the local transport path', async () => {
    await auth.withLocalAgentAuthorization(rootSecret, async authorization => {
      expect(authorization.authContext.roles.some(role => role.role === 'platform_admin')).toBe(true)
      await expect(auth.authenticateHeaders(authorization.headers)).resolves.toBeNull()
      await expect(auth.authenticateLocalAgentHeaders(authorization.headers)).resolves.toMatchObject({
        userId: authorization.authContext.userId,
      })
    })

    expect((await accountRepository.list()).every(account =>
      !account.email.endsWith('@local-agent.geo-agent-platform.invalid'))).toBe(true)
  }, 30_000)
})

async function signInStatus(auth: BetterAuthService, email: string, password: string): Promise<number> {
  const response = await auth.auth.api.signInEmail({
    body: { email, password, rememberMe: false },
    asResponse: true,
  })
  return response.status
}

// +-------------------------------------------------------------------------
//   地理智能平台 - 推送授权与有界队列回归测试
//   文件: WsOutboundGuard.test.ts
//   日期: 2026年09月08日
//   AI 协助: OpenAI ChatGPT (GPT-6 Astra Pro)
// --------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { describe, it } from 'vitest'
import { WsOutboundGuard, type WsDeliveryScope } from './WsOutboundGuard.js'
import { createWsDeliveryAuthorizer, wsAuthNotExpired, type WsDeliverySecurity } from './deliveryAuthorization.js'
import type { AuthContext, AuthRoleBinding } from '../security/types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const scope: WsDeliveryScope = { object: 'run', resourceId: 'run-1' }
const auth: AuthContext = {
  userId: 'user-1', subject: 'subject-1', email: 'test@example.invalid', displayName: '测试',
  authSessionId: 'auth-1', authSessionExpiresAt: '2099-01-01T00:00:00.000Z',
  csrfToken: 'test-only', defaultWorkspaceId: 'workspace-a',
  roles: [{ workspaceId: 'workspace-a', role: 'analyst' }],
}

function fixture(overrides: Partial<ConstructorParameters<typeof WsOutboundGuard>[0]> = {}) {
  const sent: string[] = []
  let denied = 0
  const guard = new WsOutboundGuard({
    authorize: async () => true, isCurrent: () => true,
    deliver: message => sent.push(message), onDenied: () => { denied += 1 }, ...overrides,
  })
  return { guard, sent, denied: () => denied }
}

describe('WsOutboundGuard', () => {
  it('preserves FIFO and reauthorizes messages arriving during a pending check', async () => {
    const first = deferred<boolean>()
    let checks = 0
    const f = fixture({ authorize: async () => ++checks === 1 ? first.promise : false })
    f.guard.enqueue(scope, 'before', 6)
    f.guard.enqueue(scope, 'after', 5)
    assert.deepEqual(f.sent, [])
    first.resolve(true)
    await setImmediate()
    assert.deepEqual(f.sent, ['before'])
    assert.equal(checks, 2)
    assert.equal(f.denied(), 1)
    assert.equal(f.guard.bufferedBytes, 0)
  })

  it('drops a pending batch if the connection is disposed before authorization resolves', async () => {
    const check = deferred<boolean>()
    const f = fixture({ authorize: () => check.promise })
    f.guard.enqueue(scope, 'secret', 6)
    f.guard.dispose()
    check.resolve(true)
    await setImmediate()
    assert.deepEqual(f.sent, [])
    assert.equal(f.guard.bufferedBytes, 0)
    assert.equal(f.denied(), 0)
  })

  it('rechecks expiry after asynchronous authorization', async () => {
    const check = deferred<boolean>()
    let current = true
    const f = fixture({ authorize: () => check.promise, isCurrent: () => current })
    f.guard.enqueue(scope, 'secret', 6)
    current = false
    check.resolve(true)
    await setImmediate()
    assert.deepEqual(f.sent, [])
    assert.equal(f.denied(), 1)
  })

  it('fails closed on authorization storage errors', async () => {
    const f = fixture({ authorize: async () => { throw new Error('database unavailable') } })
    f.guard.enqueue(scope, 'secret', 6)
    await setImmediate()
    assert.deepEqual(f.sent, [])
    assert.equal(f.denied(), 1)
    assert.equal(f.guard.bufferedBytes, 0)
  })

  it('bounds bytes while authorization is pending', async () => {
    const check = deferred<boolean>()
    const f = fixture({ authorize: () => check.promise, maxBytes: 8 })
    f.guard.enqueue(scope, '12345', 5)
    f.guard.enqueue(scope, '6789', 4)
    assert.equal(f.denied(), 1)
    check.resolve(true)
    await setImmediate()
    assert.deepEqual(f.sent, [])
  })

  it('bounds message slots even for empty payloads', async () => {
    const check = deferred<boolean>()
    const f = fixture({ authorize: () => check.promise, maxMessages: 2 })
    f.guard.enqueue(scope, '', 0)
    f.guard.enqueue(scope, '', 0)
    f.guard.enqueue(scope, '', 0)
    assert.equal(f.denied(), 1)
    check.resolve(true)
    await setImmediate()
    assert.deepEqual(f.sent, [])
  })
})

describe('current delivery authorization', () => {
  function authorizationFixture() {
    let active = true
    let roles: AuthRoleBinding[] = [...auth.roles]
    let workspaceId: string | null = 'workspace-a'
    let checks = 0
    const security: WsDeliverySecurity = {
      auth: { listUserRoles: async () => roles, isAuthContextActive: async () => active },
      authorization: {
        can: async (current, _object, _action, resource) => {
          checks += 1
          return current.roles.some(role => role.workspaceId === resource.workspaceId)
        },
      },
    }
    const authorize = createWsDeliveryAuthorizer(auth, security, {
      getRun: () => ({ workspaceId }), getThread: () => ({ workspaceId }),
    })
    return { authorize, checks: () => checks,
      revoke: () => { roles = [{ workspaceId: 'workspace-b', role: 'analyst' }] },
      disable: () => { active = false }, move: () => { workspaceId = 'workspace-b' },
      removeOwner: () => { workspaceId = null } }
  }

  it('uses fresh roles even when the user still has another workspace', async () => {
    const f = authorizationFixture()
    assert.equal(await f.authorize([scope]), true)
    f.revoke()
    assert.equal(await f.authorize([scope]), false)
  })

  it('rejects revoked sessions without an inbound command', async () => {
    const f = authorizationFixture()
    f.disable()
    assert.equal(await f.authorize([scope]), false)
    assert.equal(await f.authorize([]), false)
  })

  it('checks current resource ownership and fails closed for missing ownership', async () => {
    const f = authorizationFixture()
    f.move()
    assert.equal(await f.authorize([scope]), false)
    f.removeOwner()
    assert.equal(await f.authorize([scope]), false)
  })

  it('checks each resource once per batch without reusing a later batch authorization', async () => {
    const f = authorizationFixture()
    assert.equal(await f.authorize([scope, scope, { object: 'thread', resourceId: 'thread-1' }]), true)
    assert.equal(f.checks(), 2)
    assert.equal(await f.authorize([scope]), true)
    assert.equal(f.checks(), 3)
  })

  it('rejects absent, expired and malformed session expiry', () => {
    assert.equal(wsAuthNotExpired(undefined), false)
    assert.equal(wsAuthNotExpired({ ...auth, authSessionExpiresAt: 'invalid' }), false)
    assert.equal(wsAuthNotExpired(auth, Date.parse(auth.authSessionExpiresAt!)), false)
    assert.equal(wsAuthNotExpired(auth, 0), true)
  })
})

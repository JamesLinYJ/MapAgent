// +-------------------------------------------------------------------------
//   地理智能平台 - 实时订阅撤权与回放队列回归测试
//   文件: subscriptionAuthorization.test.ts
//   日期: 2026年09月08日
//   AI 协助: OpenAI ChatGPT (GPT-6 Astra Pro)
// --------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { describe, it } from 'vitest'
import { WebSocket } from 'ws'
import type { AuthContext, AuthRoleBinding } from '../security/types.js'
import type { PlatformEventHub } from '../store/platformEventHub.js'
import { createWsDeliveryAuthorizer, wsAuthNotExpired, type WsDeliverySecurity } from './deliveryAuthorization.js'
import {
  installWsDeliveryGuard, reserveRunCapture, reserveRunDelivery, sendRunWs,
  sendWs, subscribeToRun, subscribeToThread, type RunSubscriptionStore,
} from './subscriptions.js'

function channel() {
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  return {
    subscribe(id: string, handler: (value: unknown) => void) {
      const bucket = listeners.get(id) ?? new Set<(value: unknown) => void>()
      listeners.set(id, bucket)
      bucket.add(handler)
      return () => { bucket.delete(handler) }
    },
    emit(id: string, value: unknown) { listeners.get(id)?.forEach(handler => handler(value)) },
  }
}

function fixture() {
  let readyState: number = WebSocket.OPEN
  let active = true
  let roles: AuthRoleBinding[] = [{ workspaceId: 'workspace-a', role: 'analyst' }]
  const sent: string[] = []
  const subscriptions = new Map<string, () => void>()
  const auth: AuthContext = {
    userId: 'user-1', subject: 'subject-1', email: 'test@example.invalid', displayName: '测试',
    authSessionId: 'auth-1', authSessionExpiresAt: '2099-01-01T00:00:00.000Z', csrfToken: 'test-only',
    defaultWorkspaceId: 'workspace-a', roles,
  }
  const security: WsDeliverySecurity = {
    auth: { isAuthContextActive: async () => active, listUserRoles: async () => roles },
    authorization: { can: async (current, _object, _action, scope) => current.roles.some(role => role.workspaceId === scope.workspaceId) },
  }
  const ws = {
    get readyState() { return readyState }, bufferedAmount: 0,
    send(message: string, callback: (error?: Error) => void) { sent.push(message); callback() },
    terminate() { readyState = WebSocket.CLOSED },
  } as unknown as WebSocket
  const resources = { getRun: () => ({ workspaceId: 'workspace-a' }), getThread: () => ({ workspaceId: 'workspace-a' }) }
  const release = installWsDeliveryGuard(ws, createWsDeliveryAuthorizer(auth, security, resources),
    () => wsAuthNotExpired(auth), () => {
      subscriptions.forEach(unsubscribe => unsubscribe())
      subscriptions.clear()
    })
  const events = {
    conversationItemUpserts: channel(), conversationItemDeltas: channel(), runEvents: channel(), runs: channel(),
    threadEntries: channel(), threadUpdates: channel(), threadCompactions: channel(), threadMemories: channel(), mapScenes: channel(),
  }
  return { ws, auth, events, subscriptions, sent, release,
    store: resources as unknown as RunSubscriptionStore,
    revokeRole: () => { roles = [{ workspaceId: 'workspace-b', role: 'analyst' }] },
    revokeSession: () => { active = false } }
}

describe('protected subscription delivery', () => {
  it('stops an existing run delta subscription after role removal without a new command', async () => {
    const f = fixture()
    try {
      subscribeToRun(f.ws, 'run-1', f.store, f.events as unknown as PlatformEventHub, f.subscriptions)
      f.events.conversationItemDeltas.emit('run-1', { delta: 'before' })
      await setImmediate()
      assert.equal(f.sent.length, 1)
      f.revokeRole()
      f.events.conversationItemDeltas.emit('run-1', { delta: 'secret-after-revoke' })
      await setImmediate()
      assert.equal(f.sent.length, 1)
      assert.equal(f.ws.readyState, WebSocket.CLOSED)
      assert.equal(f.subscriptions.size, 0)
    } finally { f.release() }
  })

  it('stops thread memory and map pushes after session revocation', async () => {
    const f = fixture()
    try {
      subscribeToThread(f.ws, 'thread-1', f.store, f.events as unknown as PlatformEventHub, f.subscriptions)
      f.revokeSession()
      f.events.threadMemories.emit('thread-1', { content: 'private memory' })
      f.events.mapScenes.emit('thread-1', { content: 'private map' })
      await setImmediate()
      assert.deepEqual(f.sent, [])
      assert.equal(f.ws.readyState, WebSocket.CLOSED)
      assert.equal(f.subscriptions.size, 0)
    } finally { f.release() }
  })

  it('reauthorizes late snapshot responses after asynchronous capture completes', async () => {
    const f = fixture()
    try {
      let complete!: (value: string) => void
      const capture = new Promise<string>(resolve => { complete = resolve })
      const reservation = reserveRunCapture<string>(f.ws, 'run-1')
      const pending = reservation.start(() => capture)
      f.revokeSession()
      complete('private snapshot')
      reservation.deliver(await pending)
      await setImmediate()
      assert.deepEqual(f.sent, [])
      assert.equal(f.ws.readyState, WebSocket.CLOSED)
    } finally { f.release() }
  })

  it('includes authorization-waiting bytes in the run queue high-water mark', async () => {
    const f = fixture()
    f.release()
    let complete!: (value: boolean) => void
    const check = new Promise<boolean>(resolve => { complete = resolve })
    const release = installWsDeliveryGuard(f.ws, () => check, () => true, () => {})
    try {
      sendRunWs(f.ws, 'run-1', 'x'.repeat(7 * 1024 * 1024))
      reserveRunDelivery(f.ws, 'run-2')
      sendRunWs(f.ws, 'run-2', 'y'.repeat(2 * 1024 * 1024))
      complete(true)
      await setImmediate()
      assert.deepEqual(f.sent, [])
      assert.equal(f.ws.readyState, WebSocket.CLOSED)
    } finally { release() }
  })

  it('retains the ordinary error-response path for an expired inbound command', () => {
    const f = fixture()
    try {
      f.revokeSession()
      sendWs(f.ws, 'session expired')
      assert.deepEqual(f.sent, ['session expired'])
    } finally { f.release() }
  })
})

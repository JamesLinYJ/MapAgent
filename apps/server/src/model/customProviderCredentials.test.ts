import { describe, expect, it } from 'vitest'

import type { AuthContext } from '../security/types.js'
import { ProviderCredentialStagingService } from './customProviderCredentials.js'

describe('ProviderCredentialStagingService', () => {
  it('binds short-lived handles to the current user session and consumes them once', () => {
    const staging = new ProviderCredentialStagingService()
    const auth = fakeAuth()
    const staged = staging.stage('sk-staged', auth, 1_000)

    expect(staged).not.toHaveProperty('secret')
    expect(staging.resolve(staged.credentialHandle, auth, 1_001)).toBe('sk-staged')
    expect(() => staging.resolve(staged.credentialHandle, {
      ...auth,
      authSessionId: 'other_session',
    }, 1_001)).toThrow('不属于当前登录会话')
    staging.consume(staged.credentialHandle, auth, 1_001)
    expect(() => staging.resolve(staged.credentialHandle, auth, 1_002)).toThrow('不存在或已经过期')
  })

  it('expires credential handles', () => {
    const staging = new ProviderCredentialStagingService()
    const auth = fakeAuth()
    const staged = staging.stage('sk-staged', auth, 1_000)
    expect(() => staging.resolve(staged.credentialHandle, auth, 1_000 + 5 * 60 * 1_000))
      .toThrow('不存在或已经过期')
  })
})

function fakeAuth(): AuthContext {
  return {
    userId: 'user_1',
    subject: 'user_1',
    email: 'user@example.com',
    displayName: 'User',
    authSessionId: 'session_1',
    authSessionExpiresAt: null,
    csrfToken: 'csrf',
    defaultWorkspaceId: 'workspace_1',
    roles: [{ workspaceId: 'workspace_1', role: 'platform_admin' }],
  }
}

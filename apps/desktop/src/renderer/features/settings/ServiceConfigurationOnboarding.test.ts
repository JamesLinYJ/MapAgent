// +-------------------------------------------------------------------------
//
//   地理智能平台 - 登录后 Provider 引导测试
//
//   文件:       ServiceConfigurationOnboarding.test.ts
//
//   日期:       2026年08月28日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  readProviderOnboardingDismissal,
  shouldOpenServiceConfigurationOnboarding,
  writeProviderOnboardingDismissal,
} from './serviceConfigurationOnboardingState'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('service configuration onboarding', () => {
  it('opens only after login permissions and a model catalog exist without an executable Agent', () => {
    expect(shouldOpenServiceConfigurationOnboarding({
      canManageProviders: true,
      providerCatalogLoaded: true,
      hasAgentProvider: false,
      dismissed: false,
    })).toBe(true)
    expect(shouldOpenServiceConfigurationOnboarding({
      canManageProviders: false,
      providerCatalogLoaded: true,
      hasAgentProvider: false,
      dismissed: false,
    })).toBe(false)
    expect(shouldOpenServiceConfigurationOnboarding({
      canManageProviders: true,
      providerCatalogLoaded: true,
      hasAgentProvider: true,
      dismissed: false,
    })).toBe(false)
  })

  it('stores a versioned, non-sensitive dismissal marker', () => {
    const values = new Map<string, string>()
    const localStorage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    }
    vi.stubGlobal('window', { localStorage })

    expect(readProviderOnboardingDismissal()).toBe(false)
    writeProviderOnboardingDismissal()
    expect(readProviderOnboardingDismissal()).toBe(true)
    expect(localStorage.setItem).toHaveBeenCalledWith(
      'geo-agent-platform:provider-onboarding:v1',
      'dismissed',
    )
  })
})

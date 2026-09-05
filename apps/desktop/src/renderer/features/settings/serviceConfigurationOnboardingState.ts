// +-------------------------------------------------------------------------
//
//   地理智能平台 - 登录后 Provider 引导状态
//
//   文件:       serviceConfigurationOnboardingState.ts
//
//   日期:       2026年08月28日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

const PROVIDER_ONBOARDING_DISMISSAL_KEY = 'geo-agent-platform:provider-onboarding:v1'

export function shouldOpenServiceConfigurationOnboarding(input: {
  canManageProviders: boolean
  providerCatalogLoaded: boolean
  hasAgentProvider: boolean
  dismissed: boolean
}): boolean {
  return input.canManageProviders
    && input.providerCatalogLoaded
    && !input.hasAgentProvider
    && !input.dismissed
}

export function readProviderOnboardingDismissal(): boolean {
  try {
    return window.localStorage.getItem(PROVIDER_ONBOARDING_DISMISSAL_KEY) === 'dismissed'
  } catch {
    return false
  }
}

export function writeProviderOnboardingDismissal(): void {
  try {
    window.localStorage.setItem(PROVIDER_ONBOARDING_DISMISSAL_KEY, 'dismissed')
  } catch {
    // 本地存储不可用时仅在当前会话跳过；不扩大为新的状态事实源。
  }
}

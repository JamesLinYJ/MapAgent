// +-------------------------------------------------------------------------
//
//   地理智能平台 - 登录后服务配置引导
//
//   文件:       ServiceConfigurationOnboarding.tsx
//
//   日期:       2026年08月28日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  CustomProviderSaveResult,
  ModelProviderDescriptor,
} from '@geo-agent-platform/shared-types'
import { useEffect, useState } from 'react'

import { supportsAgentSdkLiveSupervisor } from '../../shared/providerCapabilities'
import { ProviderSetupWizard } from './ProviderSetupWizard'
import {
  readProviderOnboardingDismissal,
  shouldOpenServiceConfigurationOnboarding,
  writeProviderOnboardingDismissal,
} from './serviceConfigurationOnboardingState'

export function ServiceConfigurationOnboarding({
  providers,
  canManageProviders,
  onSaved,
}: {
  providers: ModelProviderDescriptor[]
  canManageProviders: boolean
  onSaved: (result: CustomProviderSaveResult) => void | Promise<void>
}) {
  const [dismissed, setDismissed] = useState(readProviderOnboardingDismissal)
  const [open, setOpen] = useState(false)
  const hasAgentProvider = providers.some(supportsAgentSdkLiveSupervisor)

  useEffect(() => {
    if (shouldOpenServiceConfigurationOnboarding({
      canManageProviders,
      providerCatalogLoaded: providers.length > 0,
      hasAgentProvider,
      dismissed,
    })) {
      setOpen(true)
    }
  }, [canManageProviders, dismissed, hasAgentProvider, providers.length])

  const dismiss = (): void => {
    writeProviderOnboardingDismissal()
    setDismissed(true)
    setOpen(false)
  }

  return (
    <ProviderSetupWizard
      open={open}
      mode="onboarding"
      onClose={dismiss}
      onSaved={async result => {
        writeProviderOnboardingDismissal()
        setDismissed(true)
        setOpen(false)
        await onSaved(result)
      }}
    />
  )
}

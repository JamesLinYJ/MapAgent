// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型连接状态 Store
//
//   文件:       modelConnectionStore.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { ModelProviderDescriptor } from '@geo-agent-platform/shared-types'
import { z } from 'zod'
import { create } from 'zustand'
import { supportsAgentSdkLiveSupervisor } from '../../shared/providerCapabilities'

const MODEL_SELECTION_STORAGE_KEY = 'geo-agent-platform:model-selection:v1'
const persistedModelSelectionSchema = z.object({
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().max(200),
}).strict()
const initialSelection = readPersistedSelection()

interface ModelConnectionState {
  providers: ModelProviderDescriptor[]
  provider: string
  model: string
  applyProviders: (providers: ModelProviderDescriptor[]) => void
  changeProvider: (provider: string) => void
  setProvider: (provider: string) => void
  setModel: (model: string) => void
}

export const useModelConnectionStore = create<ModelConnectionState>((set, get) => ({
  providers: [],
  provider: initialSelection?.provider ?? 'deepseek',
  model: initialSelection?.model ?? '',
  applyProviders: providers => {
    const currentProvider = get().provider
    const currentModel = get().model
    const current = providers.find(item => (
      item.provider === currentProvider && supportsAgentSdkLiveSupervisor(item)
    ))
    const executable =
      current ??
      providers.find(item => item.provider === 'deepseek' && supportsAgentSdkLiveSupervisor(item)) ??
      providers.find(item => supportsAgentSdkLiveSupervisor(item))
    const visible = executable
      ?? providers.find(item => item.provider === currentProvider)
      ?? providers.find(item => item.provider === 'deepseek')
      ?? providers[0]
    const availableModels = executable
      ? new Set([executable.defaultModel, ...executable.availableModels].filter(Boolean))
      : new Set<string>()
    const nextProvider = visible?.provider ?? currentProvider
    const nextModel = executable
      ? executable.provider === currentProvider && availableModels.has(currentModel)
        ? currentModel
        : executable.defaultModel ?? ''
      : ''
    set({
      providers,
      model: nextModel,
      ...(visible ? {
        provider: nextProvider,
      } : {}),
    })
    if (executable) {
      persistSelection(nextProvider, nextModel)
    } else {
      clearPersistedSelection()
    }
  },
  changeProvider: provider => {
    const selected = get().providers.find(item => item.provider === provider)
    const available = supportsAgentSdkLiveSupervisor(selected)
    const model = available ? selected?.defaultModel ?? '' : ''
    set({ provider, model })
    if (available) persistSelection(provider, model)
    else clearPersistedSelection()
  },
  setProvider: provider => {
    set({ provider })
    persistSelection(provider, get().model)
  },
  setModel: model => {
    set({ model })
    persistSelection(get().provider, model)
  },
}))

function readPersistedSelection(): { provider: string; model: string } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(MODEL_SELECTION_STORAGE_KEY)
    if (!raw) return null
    const parsed = persistedModelSelectionSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function persistSelection(provider: string, model: string): void {
  const parsed = persistedModelSelectionSchema.safeParse({ provider, model })
  if (!parsed.success || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MODEL_SELECTION_STORAGE_KEY, JSON.stringify(parsed.data))
  } catch {
    // localStorage 不可用时仍保留当前会话内的 Zustand 状态。
  }
}

function clearPersistedSelection(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(MODEL_SELECTION_STORAGE_KEY)
  } catch {
    // 存储不可用时，内存状态仍会清空无效模型选择。
  }
}

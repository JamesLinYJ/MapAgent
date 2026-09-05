// +-------------------------------------------------------------------------
//
//   地理智能平台 - 服务与模型设置页
//
//   文件:       ModelSettingsPage.tsx
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-28):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 统一模型、地图与平台连接配置，并接入模板化 Provider 向导。
// --------------------------------------------------------------------------

import type {
  CustomProviderRecord,
  CustomProviderSaveResult,
  ModelProviderDescriptor,
} from '@geo-agent-platform/shared-types'
import {
  Check,
  CircleUserRound,
  Cpu,
  KeyRound,
  MapPinned,
  Plus,
  Route,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { DesktopAuthMode } from '../../app/useWorkspaceBootstrap'
import { useProductIdentity } from '../../app/ProductIdentityContext'
import {
  deleteCustomProvider,
  listCustomProviders,
  listProviders,
} from '../../api/client'
import { PlatformTransportError } from '../../api/errors'
import { requireDesktopBridge } from '../../api/transport'
import {
  agentRuntimeCapabilitySummary,
  providerUnavailableLabel,
  supportsAgentSdkLiveSupervisor,
} from '../../shared/providerCapabilities'
import { ProviderSetupWizard } from './ProviderSetupWizard'
import { MacosCliSettingsCard } from './MacosCliSettingsCard'
import type { ProviderTemplateId } from './providerTemplates'

export interface ModelSettingsPageProps {
  authMode: DesktopAuthMode
  canAccessAccount: boolean
  provider: string
  model: string
  providers: ModelProviderDescriptor[]
  onProviderChange: (provider: string) => void
  onModelChange: (model: string) => void
  onOpenAccount: () => void
  canManageProviders?: boolean
  onProviderCatalogChanged?: (providers: ModelProviderDescriptor[]) => void
}

interface WizardState {
  open: boolean
  record: CustomProviderRecord | null
  template?: ProviderTemplateId
}

const CLOSED_WIZARD: WizardState = { open: false, record: null }

export function ModelSettingsPage({
  authMode,
  canAccessAccount,
  provider,
  model,
  providers,
  onProviderChange,
  onModelChange,
  onOpenAccount,
  canManageProviders = false,
  onProviderCatalogChanged,
}: ModelSettingsPageProps) {
  const [customProviders, setCustomProviders] = useState<CustomProviderRecord[]>([])
  const [wizard, setWizard] = useState<WizardState>(CLOSED_WIZARD)
  const [providerBusy, setProviderBusy] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [providerNotice, setProviderNotice] = useState<string | null>(null)
  const selectedProvider = providers.find(item => item.provider === provider)
  const { productName, openProductSettings, setupStatus } = useProductIdentity()
  const selectedProviderAvailable = supportsAgentSdkLiveSupervisor(selectedProvider)
  const selectedModel = selectedProviderAvailable ? model || selectedProvider?.defaultModel || '' : ''
  const selectedRouteAvailable = selectedProviderAvailable && Boolean(selectedModel)
  const models = selectedProviderAvailable ? uniqueModels(selectedProvider) : []
  const customById = useMemo(
    () => new Map(customProviders.map(record => [record.providerId, record])),
    [customProviders],
  )
  const hasAgentProvider = providers.some(supportsAgentSdkLiveSupervisor)

  useEffect(() => {
    if (!canManageProviders) return
    void listCustomProviders().then(setCustomProviders).catch(error => {
      setProviderError(safeMessage(error, '模型服务配置目录加载失败。'))
    })
  }, [canManageProviders])

  const refreshAfterMutation = async (): Promise<{
    custom: CustomProviderRecord[]
    catalog: ModelProviderDescriptor[]
  }> => {
    const [custom, catalog] = await Promise.all([listCustomProviders(), listProviders()])
    setCustomProviders(custom)
    onProviderCatalogChanged?.(catalog)
    return { custom, catalog }
  }

  const handleSaved = async (result: CustomProviderSaveResult): Promise<void> => {
    const { catalog } = await refreshAfterMutation()
    const saved = catalog.find(item => item.provider === result.provider.providerId)
    if (saved && supportsAgentSdkLiveSupervisor(saved)) {
      onProviderChange(result.provider.providerId)
      onModelChange(saved.defaultModel ?? result.provider.defaultModel)
    }
    setWizard(CLOSED_WIZARD)
    setProviderError(null)
    setProviderNotice(supportsAgentSdkLiveSupervisor(saved)
      ? `${result.provider.displayName} 已保存，并已切换到默认模型。`
      : `${result.provider.displayName} 已保存；默认模型未声明工具调用和结构化输出，因此未切换当前智能分析路由。`)
  }

  const removeProvider = async (record: CustomProviderRecord): Promise<void> => {
    const restoresBuiltin = record.providerId === 'deepseek' || record.providerId === 'ollama'
    const confirmed = await requireDesktopBridge().dialog.confirm({
      title: restoresBuiltin ? '恢复内置模型服务配置' : '删除模型服务配置',
      message: `确认移除“${record.displayName}”的设置页配置吗？`,
      detail: restoresBuiltin
        ? '设置页覆盖配置和已保存访问密钥会被删除，内置服务恢复为不含访问密钥的默认状态。'
        : '该模型服务及其已保存访问密钥会一并删除，此操作无法撤销。',
      confirmLabel: restoresBuiltin ? '移除覆盖配置' : '删除模型服务',
      cancelLabel: '取消',
      tone: 'danger',
    })
    if (!confirmed) return

    setProviderBusy(true)
    setProviderError(null)
    try {
      await deleteCustomProvider(record.providerId, record.revision)
      const { catalog } = await refreshAfterMutation()
      if (provider === record.providerId) {
        const fallback = preferredAgentProvider(catalog)
        if (fallback) {
          onProviderChange(fallback.provider)
          onModelChange(fallback.defaultModel ?? '')
        }
      }
      setProviderNotice(restoresBuiltin
        ? `${record.displayName} 已恢复为不含访问密钥的内置默认状态。`
        : `${record.displayName} 及其已保存访问密钥已删除。`)
    } catch (error) {
      setProviderError(error instanceof PlatformTransportError && error.code === 'version_conflict'
        ? '该模型服务已在另一个窗口更新，请重新打开设置后再删除。'
        : safeMessage(error, '模型服务配置删除失败。'))
    } finally {
      setProviderBusy(false)
    }
  }

  return (
    <main className="model-settings ui-page">
      <header className="model-settings__hero ui-page-header">
        <div className="model-settings__hero-icon" aria-hidden="true"><Sparkles size={25} /></div>
        <div>
          <span className="model-settings__eyebrow">服务配置中心</span>
          <h1>服务与模型</h1>
          <p>模型、地图和平台连接都可在这里维护；无需修改环境变量，访问密钥不会写入界面持久存储。</p>
        </div>
        <div className={`model-settings__summary${selectedRouteAvailable ? '' : ' is-unavailable'}`}>
          <span><i /> 当前路由</span>
          <strong>{selectedProvider?.displayName ?? provider}</strong>
          <small>{selectedModel || '尚未选择可用模型'}</small>
        </div>
      </header>

      {!hasAgentProvider ? (
        <section className="model-settings__warning" role="status">
          <TriangleAlert size={20} />
          <div><strong>尚未配置可执行模型</strong><span>地图与工作台仍可使用，但启动智能分析前需要先配置模型服务。</span></div>
          {canManageProviders ? (
            <button type="button" onClick={() => setWizard({ open: true, record: null })}>打开配置向导</button>
          ) : null}
        </section>
      ) : null}

      <section className="model-settings__section ui-page-section" aria-labelledby="model-provider-title">
        <div className="model-settings__section-heading">
          <div>
            <span className="model-settings__eyebrow">01 · 模型服务</span>
            <h2 id="model-provider-title">模型服务与运行路由</h2>
            <p>模型地址、能力与访问密钥统一由设置页维护；DeepSeek 和 Ollama 的覆盖配置不会生成重复卡片。</p>
          </div>
          {canManageProviders ? (
            <button type="button" className="model-settings__custom-add" onClick={() => setWizard({ open: true, record: null })}>
              <Plus size={15} />添加模型服务
            </button>
          ) : <Route size={22} aria-hidden="true" />}
        </div>

        {providerNotice ? <p className="model-settings__custom-notice" role="status">{providerNotice}</p> : null}
        {providerError ? <p className="model-settings__custom-error" role="alert">{providerError}</p> : null}

        <div className="model-settings__provider-grid">
          {providers.map(item => {
            const record = customById.get(item.provider)
            const available = supportsAgentSdkLiveSupervisor(item)
            const active = item.provider === provider
            const configurableBuiltin = item.provider === 'deepseek' || item.provider === 'ollama'
            return (
              <article
                key={item.provider}
                className={[
                  'model-settings__provider-card ui-card',
                  active && available ? 'is-active' : '',
                  available ? '' : 'is-disabled',
                ].filter(Boolean).join(' ')}
              >
                <button
                  type="button"
                  className="model-settings__provider-select"
                  disabled={!available}
                  aria-pressed={active}
                  onClick={() => onProviderChange(item.provider)}
                >
                  <span className="model-settings__provider-icon"><Cpu size={18} /></span>
                  <span className="model-settings__provider-copy">
                    <strong>{item.displayName}</strong>
                    <small>{agentRuntimeCapabilitySummary(item)}</small>
                    {record ? <code>{record.baseUrl}</code> : null}
                  </span>
                  <span className="model-settings__provider-state">
                    {active && available
                      ? <Check size={16} />
                      : active
                        ? '当前不可用'
                        : providerUnavailableLabel(item) || '可用'}
                  </span>
                </button>
                <div className="model-settings__provider-meta">
                  <span>{record ? '设置页配置' : item.configured ? '环境配置' : '未配置'}</span>
                  <span>{providerProtocolLabel(item)}</span>
                  {record ? <span><KeyRound size={11} />{record.hasApiKey ? '访问密钥已保存' : '无密钥'}</span> : null}
                  {record ? <span>最近测试 {formatTimestamp(record.lastValidatedAt)}</span> : null}
                </div>
                {canManageProviders && (record || configurableBuiltin) ? (
                  <div className="model-settings__custom-actions">
                    <button
                      type="button"
                      disabled={providerBusy}
                      onClick={() => setWizard(record
                        ? { open: true, record }
                        : { open: true, record: null, template: item.provider as 'deepseek' | 'ollama' })}
                    >
                      {record ? '编辑' : '配置'}
                    </button>
                    {record ? (
                      <button type="button" className="is-danger" disabled={providerBusy} onClick={() => { void removeProvider(record) }}>
                        <Trash2 size={13} />{configurableBuiltin ? '移除覆盖配置' : '删除'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            )
          })}
          {!providers.length ? <div className="model-settings__empty">正在等待服务端返回模型服务目录。</div> : null}
        </div>
      </section>

      <section className="model-settings__section ui-page-section" aria-labelledby="model-choice-title">
        <div className="model-settings__section-heading">
          <div>
            <span className="model-settings__eyebrow">02 · 当前模型</span>
            <h2 id="model-choice-title">选择具体模型</h2>
            <p>只展示当前模型服务已保存的模型能力快照。</p>
          </div>
          <Sparkles size={22} aria-hidden="true" />
        </div>
        <div className="model-settings__model-list">
          {models.map(item => {
            const active = item === selectedModel
            const capabilities = selectedProvider?.models.find(candidate => candidate.modelId === item)
            return (
              <button key={item} type="button" className={active ? 'is-active' : ''} aria-pressed={active} onClick={() => onModelChange(item)}>
                <span><strong>{item}</strong><small>{modelCapabilityLabel(item === selectedProvider?.defaultModel, capabilities)}</small></span>
                {active ? <Check size={17} /> : null}
              </button>
            )
          })}
          {!models.length ? <div className="model-settings__empty">当前路由没有可用模型。</div> : null}
        </div>
      </section>

      <section className="model-settings__identity ui-page-section ui-page-section--compact" aria-labelledby="map-service-title">
        <span className="model-settings__identity-icon"><MapPinned size={22} /></span>
        <div>
          <span className="model-settings__eyebrow">03 · 地图服务</span>
          <h2 id="map-service-title">天地图</h2>
          <p>{mapServiceSummary(setupStatus)}</p>
        </div>
        {setupStatus?.deploymentMode === 'local_managed' && setupStatus.canConfigureMapService ? (
          <button type="button" onClick={openProductSettings}>
            {setupStatus.tiandituConfigured ? '替换或清除密钥' : '配置密钥'}
          </button>
        ) : null}
      </section>

      <section className="model-settings__identity ui-page-section ui-page-section--compact" aria-labelledby="platform-connection-title">
        <span className="model-settings__identity-icon"><Server size={22} /></span>
        <div>
          <span className="model-settings__eyebrow">04 · 平台连接</span>
          <h2 id="platform-connection-title">{productName}</h2>
          <p>{setupStatus ? `${platformConnectionLabel(setupStatus)} · ${setupStatus.apiBaseUrl}` : '由桌面主进程管理服务地址。'}</p>
        </div>
        <button type="button" onClick={openProductSettings}>
          {setupStatus?.deploymentMode === 'local_managed' ? '修改名称与地图' : '修改名称与连接'}
        </button>
      </section>

      {typeof window !== 'undefined' && window.platformDesktop?.platform === 'darwin'
        ? <MacosCliSettingsCard />
        : null}

      <section className="model-settings__identity ui-page-section ui-page-section--compact" aria-labelledby="identity-title">
        <span className="model-settings__identity-icon">
          {authMode === 'local_auto' ? <ShieldCheck size={22} /> : <CircleUserRound size={22} />}
        </span>
        <div>
          <span className="model-settings__eyebrow">06 · 身份</span>
          <h2 id="identity-title">{authMode === 'local_auto' ? '本机身份由应用托管' : '正在使用扩展账号模式'}</h2>
          <p>{authMode === 'local_auto'
            ? '启动时自动建立受保护的本机会话；无需注册或输入账号。'
            : '账号能力用于多人协作与远程权限。'}</p>
        </div>
        {canAccessAccount ? <button type="button" onClick={onOpenAccount}>打开账号中心</button> : null}
      </section>

      <ProviderSetupWizard
        open={wizard.open}
        record={wizard.record}
        initialTemplate={wizard.template}
        onClose={() => {
          setWizard(CLOSED_WIZARD)
          void refreshAfterMutation().catch(error => {
            setProviderError(safeMessage(error, '模型服务配置目录刷新失败。'))
          })
        }}
        onSaved={handleSaved}
      />
    </main>
  )
}

function uniqueModels(provider: ModelProviderDescriptor | undefined): string[] {
  if (!provider) return []
  return [...new Set([provider.defaultModel, ...provider.availableModels]
    .filter((value): value is string => Boolean(value?.trim())))]
}

function preferredAgentProvider(providers: ModelProviderDescriptor[]): ModelProviderDescriptor | null {
  return providers.find(item => item.provider === 'deepseek' && supportsAgentSdkLiveSupervisor(item))
    ?? providers.find(supportsAgentSdkLiveSupervisor)
    ?? null
}

function providerProtocolLabel(provider: ModelProviderDescriptor): string {
  if (provider.agentRuntime.transport === 'none') return '未接入智能分析'
  if (provider.protocol === 'responses') return '响应接口'
  if (provider.protocol === 'chat_completions') return '对话补全接口'
  return '专用适配器'
}

function modelCapabilityLabel(
  isDefault: boolean,
  model: ModelProviderDescriptor['models'][number] | undefined,
): string {
  if (!model) return isDefault ? '默认模型' : '可用模型'
  const contextWindow = new Intl.NumberFormat('zh-CN').format(model.contextWindowTokens)
  const modalities = model.modalities.map(modalityLabel).join('/')
  return `${isDefault ? '默认模型' : '可用模型'} · ${contextWindow} 词元 · ${modalities}`
}

function modalityLabel(modality: 'text' | 'image' | 'audio' | 'pdf'): string {
  if (modality === 'text') return '文本'
  if (modality === 'image') return '图片'
  if (modality === 'audio') return '音频'
  return 'PDF'
}

function mapServiceSummary(
  setupStatus: ReturnType<typeof useProductIdentity>['setupStatus'],
): string {
  if (!setupStatus) return '地图服务状态由桌面主进程管理。'
  if (setupStatus.deploymentMode === 'remote') return '地图密钥由当前平台服务管理，桌面端不会读取或保存它。'
  if (!setupStatus.canConfigureMapService) return '当前本机运行清单不允许桌面应用修改地图密钥。'
  return setupStatus.tiandituConfigured
    ? '天地图服务端密钥已配置，可在此替换或清除。'
    : '尚未配置天地图服务端密钥；不影响进入工作台，可随时补充。'
}

function platformConnectionLabel(
  setupStatus: NonNullable<ReturnType<typeof useProductIdentity>['setupStatus']>,
): string {
  if (setupStatus.deploymentMode === 'local_managed') return '本机受管运行时'
  try {
    const hostname = new URL(setupStatus.apiBaseUrl).hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
      return '本机服务'
    }
  } catch {
    // IPC schema 已保证 URL 合法；这里只保留稳定的显示降级。
  }
  return '远程服务'
}

function formatTimestamp(value: string | null): string {
  if (!value) return '尚未执行'
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
    : '未知时间'
}

function safeMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.replace(/[\r\n]+/gu, ' ').slice(0, 800)
  return fallback
}

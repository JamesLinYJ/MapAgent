// +-------------------------------------------------------------------------
//
//   地理智能平台 - 首次设置门与连接设置
//
//   文件:       ProductSetupGate.tsx
// --------------------------------------------------------------------------

import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleGauge,
  KeyRound,
  MapPinned,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'

import type {
  DesktopProductSetupStatus,
  DesktopProductSetupTestResult,
} from '../../contracts/desktopIpc'
import { desktopMenuCommandSchema } from '../../contracts/desktopIpc'
import { BootScreen } from './AppLoader'
import { useDesktopEventRouter } from './events/DesktopEventRouterContext'
import { ProductIdentityProvider } from './ProductIdentityProvider'
import { StartupScreen } from './StartupScreen'
import './styles/glass.css'
import './styles/product-setup.css'

export function ProductSetupGate({ children }: { children: ReactNode }) {
  const desktopEvents = useDesktopEventRouter()
  const [status, setStatus] = useState<DesktopProductSetupStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const bridge = window.platformDesktop
      if (!bridge) throw new Error('桌面安全桥未加载。')
      setStatus(await bridge.setup.status())
      setError(null)
    } catch (reason) {
      setError(safeMessage(reason))
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    return desktopEvents.subscribe(event => {
      if (event.event !== 'desktop:command') return
      const command = desktopMenuCommandSchema.safeParse(
        event.payload && typeof event.payload === 'object' && 'command' in event.payload
          ? event.payload.command
          : null,
      )
      if (command.success && command.data === 'open-connection-settings') {
        setSettingsOpen(true)
      }
    })
  }, [desktopEvents])

  if (!status && !error) return <BootScreen />
  if (!status) {
    return <SetupLoadFailure message={error ?? '无法读取首次设置。'} onRetry={loadStatus} />
  }
  if (status.state === 'required') {
    return (
      <ProductSetupWizard
        deploymentMode={status.deploymentMode}
        suggestedApiBaseUrl={status.suggestedApiBaseUrl}
        suggestedProductName={status.suggestedProductName}
        canConfigureMapService={status.canConfigureMapService}
        tiandituConfigured={status.tiandituConfigured}
      />
    )
  }
  return (
    <ProductIdentityProvider
      productName={status.productName}
      onOpenSettings={() => setSettingsOpen(true)}
      setupStatus={status}
    >
      {children}
      {settingsOpen ? (
        <ConnectionSettings
          status={status}
          onClose={() => setSettingsOpen(false)}
          onSaved={nextStatus => {
            setStatus(nextStatus)
            setSettingsOpen(false)
          }}
        />
      ) : null}
    </ProductIdentityProvider>
  )
}

function ProductSetupWizard({
  deploymentMode,
  suggestedApiBaseUrl,
  suggestedProductName,
  canConfigureMapService,
  tiandituConfigured,
}: {
  deploymentMode: 'local_managed' | 'remote'
  suggestedApiBaseUrl: string
  suggestedProductName: string
  canConfigureMapService: boolean
  tiandituConfigured: boolean | null
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [apiBaseUrl, setApiBaseUrl] = useState(suggestedApiBaseUrl)
  const [productName, setProductName] = useState(suggestedProductName)
  const [tiandituApiKey, setTiandituApiKey] = useState('')
  const [testResult, setTestResult] = useState<DesktopProductSetupTestResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const testConnection = async (event?: FormEvent) => {
    event?.preventDefault()
    const bridge = window.platformDesktop
    if (!bridge) return
    setBusy(true)
    setError(null)
    setTestResult(null)
    try {
      const result = await bridge.setup.test({ apiBaseUrl, productName })
      setTestResult(result)
      if (result.ok) setApiBaseUrl(result.apiBaseUrl)
    } catch (reason) {
      setError(safeMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const finish = async () => {
    const bridge = window.platformDesktop
    if (!bridge) return
    setBusy(true)
    setError(null)
    try {
      await bridge.setup.save({
        apiBaseUrl,
        productName,
        ...(deploymentMode === 'local_managed'
          && canConfigureMapService
          && tiandituApiKey.trim()
          ? { tiandituApiKey }
          : {}),
      })
      await bridge.setup.restart()
    } catch (reason) {
      setError(safeMessage(reason))
      setBusy(false)
    }
  }

  return (
    <main className="product-setup">
      <div className="product-setup__terrain" aria-hidden="true" />
      <header className="product-setup__masthead">
        <span className="product-setup__brand-mark"><MapPinned size={18} /></span>
        <span>{productName.trim() || suggestedProductName}</span>
        <small>地理智能工作台</small>
      </header>
      <section className="product-setup__frame" aria-labelledby="product-setup-title">
        <SetupRail step={step} />
        <div className="product-setup__content">
          {step === 1 ? (
            <WelcomeStep
              deploymentMode={deploymentMode}
              productName={productName}
              onProductNameChange={setProductName}
              onContinue={() => setStep(2)}
            />
          ) : step === 2 ? (
            <ConnectionStep
              deploymentMode={deploymentMode}
              canConfigureMapService={canConfigureMapService}
              apiBaseUrl={apiBaseUrl}
              tiandituApiKey={tiandituApiKey}
              busy={busy}
              error={error}
              result={testResult}
              onBack={() => setStep(1)}
              onChange={value => {
                setApiBaseUrl(value)
                setTestResult(null)
                setError(null)
              }}
              onTiandituApiKeyChange={value => {
                setTiandituApiKey(value)
                setError(null)
              }}
              onSubmit={testConnection}
              onContinue={() => setStep(3)}
            />
          ) : (
            <ReviewStep
              deploymentMode={deploymentMode}
              apiBaseUrl={apiBaseUrl}
              productName={productName}
              tiandituConfigured={deploymentMode === 'local_managed'
                && (tiandituApiKey.trim().length >= 16 || tiandituConfigured === true)}
              busy={busy}
              error={error}
              result={testResult}
              onBack={() => setStep(2)}
              onFinish={finish}
            />
          )}
        </div>
      </section>
      <footer className="product-setup__footer">
        <span>底图 Key 仅保存在本机 0600 运行配置，不进入安装包或前端</span>
        <span>Desktop protocol 1</span>
      </footer>
    </main>
  )
}

function SetupRail({ step }: { step: 1 | 2 | 3 }) {
  const items = [
    { step: 1, label: '命名', description: '设置显示名称' },
    { step: 2, label: '连接', description: '确认服务部署' },
    { step: 3, label: '完成', description: '保存并启动' },
  ] as const
  return (
    <aside className="product-setup__rail" aria-label="设置进度">
      <div className="product-setup__coordinate">30°16′N · 120°09′E</div>
      <ol>
        {items.map(item => (
          <li key={item.step} data-state={item.step === step ? 'active' : item.step < step ? 'done' : 'pending'}>
            <span className="product-setup__step-index">
              {item.step < step ? <Check size={14} /> : `0${item.step}`}
            </span>
            <span><strong>{item.label}</strong><small>{item.description}</small></span>
          </li>
        ))}
      </ol>
      <div className="product-setup__rail-note">
        <ShieldCheck size={18} />
        <span>服务凭据始终由系统认证组件管理。</span>
      </div>
    </aside>
  )
}

function WelcomeStep({
  deploymentMode,
  productName,
  onProductNameChange,
  onContinue,
}: {
  deploymentMode: 'local_managed' | 'remote'
  productName: string
  onProductNameChange: (value: string) => void
  onContinue: () => void
}) {
  const localManaged = deploymentMode === 'local_managed'
  return (
    <div className="product-setup__step product-setup__welcome">
      <span className="product-setup__eyebrow">首次启动 · 约 1 分钟</span>
      <h1 id="product-setup-title">为你的地理智能<br />工作台命名</h1>
      <p>{localManaged
        ? '本机运行时已经部署完成。填写一个显示名称后，应用会自动连接并启动后台服务。'
        : '填写工作台显示名称，再连接已有的本机、团队或云端地理智能服务。'}</p>
      <label className="product-setup__field">
        <span>产品显示名称</span>
        <span className="product-setup__input-shell">
          <Settings2 size={17} />
          <input
            autoFocus
            required
            maxLength={80}
            value={productName}
            onChange={event => onProductNameChange(event.target.value)}
            placeholder="我的地理工作台"
          />
        </span>
        <small>只保存在当前电脑；安装包名称、协议和数据目录不会改变。</small>
      </label>
      <div className="product-setup__mode-card">
        <span className="product-setup__mode-icon"><Server size={22} /></span>
        <span>
          <strong>{localManaged ? '本机受管部署' : '连接已有部署'}</strong>
          <small>{localManaged ? 'RPM 已安装并配置系统运行时' : '适用于团队服务器、云主机或本机独立运行时'}</small>
        </span>
        <CheckCircle2 size={19} />
      </div>
      <ul className="product-setup__facts">
        <li><Check size={14} /> 不在安装包中写入数据库或模型参数</li>
        <li><Check size={14} /> 完成登录后再配置模型供应商</li>
        <li><Check size={14} /> 随时可从设置页或“帮助 → 服务连接设置”更改</li>
      </ul>
      <div className="product-setup__actions is-end">
        <button
          type="button"
          className="product-setup__primary"
          disabled={!productName.trim()}
          onClick={onContinue}
        >
          开始设置 <ArrowRight size={16} />
        </button>
      </div>
    </div>
  )
}

function ConnectionStep({
  deploymentMode,
  canConfigureMapService,
  apiBaseUrl,
  tiandituApiKey,
  busy,
  error,
  result,
  onBack,
  onChange,
  onTiandituApiKeyChange,
  onSubmit,
  onContinue,
}: {
  deploymentMode: 'local_managed' | 'remote'
  canConfigureMapService: boolean
  apiBaseUrl: string
  tiandituApiKey: string
  busy: boolean
  error: string | null
  result: DesktopProductSetupTestResult | null
  onBack: () => void
  onChange: (value: string) => void
  onTiandituApiKeyChange: (value: string) => void
  onSubmit: (event: FormEvent) => void
  onContinue: () => void
}) {
  if (deploymentMode === 'local_managed') {
    return (
      <div className="product-setup__step">
        <span className="product-setup__eyebrow">本机运行时</span>
        <h1 id="product-setup-title">后台已经随应用安装</h1>
        <p>首次进入工作台后，桌面端会自动启动 PostgreSQL/PostGIS、Python 科学计算服务和平台 API。</p>
        <div className="product-setup__mode-card">
          <span className="product-setup__mode-icon"><Server size={22} /></span>
          <span><strong>受管服务地址</strong><small>{apiBaseUrl}</small></span>
          <CheckCircle2 size={19} />
        </div>
        {canConfigureMapService ? (
          <label className="product-setup__field">
            <span>天地图服务端 API KEY</span>
            <span className="product-setup__input-shell">
              <KeyRound size={17} />
              <input
                autoFocus
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={tiandituApiKey}
                onChange={event => onTiandituApiKeyChange(event.target.value)}
                placeholder="填写服务端 Key"
              />
            </span>
            <small>保存前会直接校验；Key 只由本机 API 代理瓦片，永不传给 Renderer。</small>
          </label>
        ) : null}
        <div className="product-setup__actions">
          <button type="button" className="product-setup__back" onClick={onBack}>
            <ArrowLeft size={16} /> 返回
          </button>
          <button
            type="button"
            className="product-setup__primary"
            onClick={onContinue}
          >
            {tiandituApiKey.trim() ? '校验后继续' : '稍后配置'} <ArrowRight size={16} />
          </button>
        </div>
      </div>
    )
  }
  return (
    <form className="product-setup__step" onSubmit={onSubmit}>
      <span className="product-setup__eyebrow">服务发现</span>
      <h1 id="product-setup-title">填写平台服务地址</h1>
      <p>请输入站点根地址。远程服务需使用 HTTPS；本机服务可以使用 127.0.0.1。</p>
      <label className="product-setup__field">
        <span>服务地址</span>
        <span className="product-setup__input-shell">
          <Server size={17} />
          <input
            autoFocus
            inputMode="url"
            spellCheck={false}
            value={apiBaseUrl}
            onChange={event => onChange(event.target.value)}
            placeholder="https://geo.example.com"
          />
        </span>
        <small>示例：https://geo.example.com 或 http://127.0.0.1:8000</small>
      </label>
      <button type="submit" className="product-setup__test" disabled={busy || !apiBaseUrl.trim()}>
        {busy ? <RefreshCw className="is-spinning" size={16} /> : <CircleGauge size={16} />}
        {busy ? '正在检查健康状态与版本…' : '测试连接'}
      </button>
      <ConnectionResult result={result} error={error} />
      <div className="product-setup__actions">
        <button type="button" className="product-setup__back" onClick={onBack}>
          <ArrowLeft size={16} /> 返回
        </button>
        <button
          type="button"
          className="product-setup__primary"
          disabled={!result?.ok}
          onClick={onContinue}
        >
          下一步 <ArrowRight size={16} />
        </button>
      </div>
    </form>
  )
}

function ReviewStep({
  deploymentMode,
  apiBaseUrl,
  productName,
  tiandituConfigured,
  busy,
  error,
  result,
  onBack,
  onFinish,
}: {
  deploymentMode: 'local_managed' | 'remote'
  apiBaseUrl: string
  productName: string
  tiandituConfigured: boolean
  busy: boolean
  error: string | null
  result: DesktopProductSetupTestResult | null
  onBack: () => void
  onFinish: () => void
}) {
  return (
    <div className="product-setup__step">
      <span className="product-setup__eyebrow">准备就绪</span>
      <h1 id="product-setup-title">工作台已经准备好</h1>
      <p>保存后应用会重新启动。模型供应商、地图服务和 API 信息都可以稍后在“设置 → 服务与模型”中填写。</p>
      <dl className="product-setup__summary">
        <div><dt>产品名称</dt><dd>{productName.trim()}</dd></div>
        <div><dt>服务地址</dt><dd>{apiBaseUrl}</dd></div>
        <div><dt>部署方式</dt><dd>{deploymentMode === 'local_managed' ? '本机受管运行时' : '远程服务'}</dd></div>
        {deploymentMode === 'local_managed' ? (
          <div><dt>地图服务</dt><dd>{tiandituConfigured ? '天地图服务端密钥已填写' : '尚未配置'}</dd></div>
        ) : null}
        {deploymentMode === 'remote' ? (
          <>
            <div><dt>服务版本</dt><dd>{result?.releaseId ?? '—'}</dd></div>
            <div><dt>数据库结构</dt><dd>v{result?.databaseSchemaVersion ?? '—'}</dd></div>
            <div><dt>检测延迟</dt><dd>{result?.latencyMs ?? '—'} ms</dd></div>
          </>
        ) : null}
      </dl>
      {error ? <p className="product-setup__error" role="alert">{error}</p> : null}
      <div className="product-setup__next-note">
        <Settings2 size={18} />
        <span><strong>下一步</strong> 登录后可使用配置向导，也可稍后从“设置 → 服务与模型”手动添加 Provider。</span>
      </div>
      <div className="product-setup__actions">
        <button type="button" className="product-setup__back" disabled={busy} onClick={onBack}>
          <ArrowLeft size={16} /> 返回
        </button>
        <button type="button" className="product-setup__primary" disabled={busy} onClick={onFinish}>
          {busy ? <RefreshCw className="is-spinning" size={16} /> : <CheckCircle2 size={16} />}
          {busy ? '正在保存…' : '保存并进入工作台'}
        </button>
      </div>
    </div>
  )
}

function ConnectionResult({
  result,
  error,
}: {
  result: DesktopProductSetupTestResult | null
  error: string | null
}) {
  if (!result && !error) return <div className="product-setup__result-placeholder" />
  const ok = result?.ok === true
  return (
    <div className="product-setup__result" data-state={ok ? 'success' : 'error'} role="status">
      {ok ? <CheckCircle2 size={18} /> : <X size={18} />}
      <span>
        <strong>{ok ? '连接成功' : '尚未连接'}</strong>
        <small>{error ?? result?.message}</small>
      </span>
      {ok ? <em>{result.latencyMs} ms</em> : null}
    </div>
  )
}

function ConnectionSettings({
  status,
  onClose,
  onSaved,
}: {
  status: Extract<DesktopProductSetupStatus, { state: 'configured' }>
  onClose: () => void
  onSaved: (status: Extract<DesktopProductSetupStatus, { state: 'configured' }>) => void
}) {
  const [productName, setProductName] = useState(status.productName)
  const [apiBaseUrl, setApiBaseUrl] = useState(status.apiBaseUrl)
  const [tiandituApiKey, setTiandituApiKey] = useState('')
  const [clearTiandituApiKey, setClearTiandituApiKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    const bridge = window.platformDesktop
    if (!bridge) return
    setBusy(true)
    setError(null)
    try {
      const nextStatus = await bridge.setup.save({
        apiBaseUrl,
        productName,
        ...(status.deploymentMode === 'local_managed'
          && status.canConfigureMapService
          && tiandituApiKey.trim()
          ? { tiandituApiKey }
          : {}),
        ...(status.deploymentMode === 'local_managed' && clearTiandituApiKey
          ? { clearTiandituApiKey: true }
          : {}),
      })
      setTiandituApiKey('')
      setClearTiandituApiKey(false)
      if (
        nextStatus.state === 'configured'
        && nextStatus.apiBaseUrl !== status.apiBaseUrl
      ) {
        await bridge.setup.restart()
        return
      }
      onSaved(nextStatus as Extract<DesktopProductSetupStatus, { state: 'configured' }>)
    } catch (reason) {
      setError(safeMessage(reason))
      setBusy(false)
    }
  }

  const reset = async () => {
    const bridge = window.platformDesktop
    if (!bridge || !status.canReset) return
    setBusy(true)
    setError(null)
    try {
      await bridge.setup.reset()
      await bridge.setup.restart()
    } catch (reason) {
      setError(safeMessage(reason))
      setBusy(false)
    }
  }

  return (
    <div className="product-connection" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section role="dialog" aria-modal="true" aria-labelledby="connection-settings-title">
        <button type="button" className="product-connection__close" aria-label="关闭" onClick={onClose}>
          <X size={18} />
        </button>
        <span className="product-connection__icon"><Settings2 size={21} /></span>
        <h2 id="connection-settings-title">工作台与服务设置</h2>
        <p>{status.deploymentMode === 'local_managed'
          ? status.canConfigureMapService
            ? '当前由本机系统运行清单统一管理。显示名称和地图服务端 Key 都可以在这里修改，无需重启桌面应用。'
            : '当前由系统管理员的运行清单统一管理。这里只修改本机显示名称。'
          : isLoopbackApiBaseUrl(status.apiBaseUrl)
            ? '当前桌面端会自动连接本机服务。无需在首次启动时填写地址；也可以在这里切换到团队的 HTTPS 部署。'
            : '当前工作台连接到团队或云端部署。显示名称可以直接修改，服务地址变更后会自动重启应用。'}</p>
        <label className="product-connection__field">
          <span>产品显示名称</span>
          <input
            value={productName}
            required
            maxLength={80}
            onChange={event => setProductName(event.target.value)}
          />
          <small>保存后立即更新当前窗口，不需要重启桌面应用。</small>
        </label>
        {status.deploymentMode === 'remote' ? (
          <label className="product-connection__field">
            <span>平台服务地址</span>
            <input
              inputMode="url"
              spellCheck={false}
              value={apiBaseUrl}
              placeholder="http://127.0.0.1:8000"
              onChange={event => setApiBaseUrl(event.target.value)}
            />
            <small>本机默认使用 127.0.0.1；非本机服务必须使用 HTTPS。地址变化后会先验证兼容性，再自动重启桌面应用。</small>
          </label>
        ) : null}
        {status.deploymentMode === 'local_managed' && status.canConfigureMapService ? (
          <label className="product-connection__field">
            <span>替换天地图服务端 API KEY</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={tiandituApiKey}
              disabled={clearTiandituApiKey}
              placeholder="留空则保留当前 Key"
              onChange={event => {
                setTiandituApiKey(event.target.value)
                setClearTiandituApiKey(false)
              }}
            />
            <small>
              当前状态：{status.tiandituConfigured ? '已配置' : '未配置'}。
              保存前会校验服务端权限；Key 仅写入本机 0600 运行配置。
            </small>
          </label>
        ) : null}
        {status.deploymentMode === 'local_managed'
          && status.canConfigureMapService
          && status.tiandituConfigured ? (
            <label className="product-connection__clear">
              <input
                type="checkbox"
                checked={clearTiandituApiKey}
                disabled={Boolean(tiandituApiKey.trim())}
                onChange={event => setClearTiandituApiKey(event.target.checked)}
              />
              清除已保存的天地图 API KEY
            </label>
          ) : null}
        <div className="product-connection__value">
          <span>当前服务</span><strong>{status.apiBaseUrl}</strong>
        </div>
        {error ? <p className="product-setup__error" role="alert">{error}</p> : null}
        <div className="product-connection__actions">
          <button type="button" onClick={onClose}>关闭</button>
          <button
            type="button"
            className="is-primary"
            disabled={busy || !productName.trim() || (
              productName.trim() === status.productName
              && apiBaseUrl.trim() === status.apiBaseUrl
              && !tiandituApiKey.trim()
              && !clearTiandituApiKey
            )}
            onClick={() => { void save() }}
          >
            {busy ? '正在保存…' : '保存设置'}
          </button>
          {status.canReset ? (
            <button type="button" disabled={busy} onClick={reset}>
              {busy ? '正在重启…' : '恢复本机默认连接'}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function SetupLoadFailure({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  return (
    <StartupScreen
      stage="桌面设置"
      title="工作台尚未就绪"
      description="无法读取本机桌面设置，可以立即重试。"
      busy={false}
      errorMessage={message}
      actions={<button type="button" onClick={() => void onRetry()}>重新启动</button>}
      footer="本机配置不会因为重新加载而丢失。"
    />
  )
}

function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.replace(/[\r\n]+/gu, ' ').slice(0, 800)
  }
  return '操作失败，请稍后重试。'
}

function isLoopbackApiBaseUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}

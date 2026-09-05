// +-------------------------------------------------------------------------
//
//   地理智能平台 - macOS 终端命令设置卡片
//
//   文件:       MacosCliSettingsCard.tsx
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  DesktopMacosCliAction,
  DesktopMacosCliStatus,
} from '../../../contracts/desktopIpc'
import { LoaderCircle, SquareTerminal } from 'lucide-react'
import { useEffect, useState } from 'react'

import { requireDesktopBridge } from '../../api/transport'

export function MacosCliSettingsCard() {
  const [status, setStatus] = useState<DesktopMacosCliStatus | null>(null)
  const [busy, setBusy] = useState<DesktopMacosCliAction | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void requireDesktopBridge().installedCli.status()
      .then(result => {
        if (active) setStatus(result)
      })
      .catch(cause => {
        if (active) setError(messageOf(cause, '无法检查终端命令状态。'))
      })
    return () => {
      active = false
    }
  }, [])

  const run = async (action: DesktopMacosCliAction): Promise<void> => {
    const bridge = requireDesktopBridge()
    if (action === 'remove') {
      const confirmed = await bridge.dialog.confirm({
        title: '移除终端命令',
        message: '确认移除本应用安装的终端命令吗？',
        detail: '只会移除指向本应用的固定链接，不会删除应用、配置或其它同名文件。',
        confirmLabel: '移除命令',
        cancelLabel: '取消',
        tone: 'danger',
      })
      if (!confirmed) return
    }

    setBusy(action)
    setError(null)
    try {
      const next = action === 'install'
        ? await bridge.installedCli.install()
        : action === 'repair'
          ? await bridge.installedCli.repair()
          : await bridge.installedCli.remove()
      setStatus(next)
    } catch (cause) {
      setError(messageOf(cause, '终端命令操作失败。'))
      try {
        setStatus(await bridge.installedCli.status())
      } catch {
        // 保留原始操作错误；状态刷新失败不覆盖更有帮助的用户反馈。
      }
    } finally {
      setBusy(null)
    }
  }

  const pending = busy !== null
  return (
    <section className="model-settings__identity ui-page-section ui-page-section--compact" aria-labelledby="macos-cli-title">
      <span className="model-settings__identity-icon"><SquareTerminal size={22} /></span>
      <div>
        <span className="model-settings__eyebrow">05 · 终端命令</span>
        <h2 id="macos-cli-title">在终端中使用智能体</h2>
        <p>{status?.message ?? '正在检查终端命令状态。'}</p>
        <code className="model-settings__cli-command">/usr/local/bin/geo-agent-platform</code>
        {error ? <span className="model-settings__cli-error" role="alert">{error}</span> : null}
      </div>
      <div className="model-settings__cli-actions" aria-live="polite">
        {pending ? <LoaderCircle size={16} className="model-settings__cli-spinner" aria-label="正在等待系统授权" /> : null}
        {status?.canInstall ? (
          <button type="button" disabled={pending} onClick={() => { void run('install') }}>
            安装命令
          </button>
        ) : null}
        {status?.canRepair ? (
          <button type="button" disabled={pending} onClick={() => { void run('repair') }}>
            修复命令
          </button>
        ) : null}
        {status?.canRemove ? (
          <button type="button" className="is-danger" disabled={pending} onClick={() => { void run('remove') }}>
            移除命令
          </button>
        ) : null}
      </div>
    </section>
  )
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback
}

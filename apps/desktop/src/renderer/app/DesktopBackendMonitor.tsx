// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面后台可用性监视器
//
//   文件:       DesktopBackendMonitor.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  OperationsServiceSnapshot,
  OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import {
  useBackendAvailabilityStore,
  type DesktopBackendAvailability,
} from './stores/backendAvailabilityStore'
import { desktopMenuCommandSchema } from '../../contracts/desktopIpc'
import { useDesktopEventRouter } from './events/DesktopEventRouterContext'
import { ensureRuntimeCompatibility } from './runtimeCompatibility'

const BACKGROUND_RECHECK_INTERVAL_MS = 5_000
const SystemLogViewer = lazy(() => import('../features/operations/SystemLogViewer').then(module => ({
  default: module.SystemLogViewer,
})))

export function DesktopBackendMonitor({ children }: { children: ReactNode }) {
  const desktopEvents = useDesktopEventRouter()
  const availability = useBackendAvailabilityStore(state => state.availability)
  const snapshot = useBackendAvailabilityStore(state => state.snapshot)
  const errorMessage = useBackendAvailabilityStore(state => state.errorMessage)
  const setAvailability = useBackendAvailabilityStore(state => state.setAvailability)
  const automaticStartAttempted = useRef(false)
  const requestInFlight = useRef(false)
  const handshakeIdentity = useRef<string | null>(null)
  const [logsOpen, setLogsOpen] = useState(false)

  const refresh = useCallback(async (allowAutomaticStart: boolean) => {
    if (requestInFlight.current) return
    requestInFlight.current = true
    try {
      const bridge = window.platformDesktop
      if (!bridge) throw new Error('桌面安全桥未加载，无法检查本机服务。')

      let current = await bridge.supervisor.status()
      if (allServicesHealthy(current)) {
        await ensureRuntimeCompatibility(current, handshakeIdentity)
        setAvailability('online', { snapshot: current, errorMessage: null })
        return
      }

      const conflictMessage = describeConflicts(current)
      if (conflictMessage) {
        setAvailability('offline', { snapshot: current, errorMessage: conflictMessage })
        return
      }

      if (allowAutomaticStart && !automaticStartAttempted.current) {
        automaticStartAttempted.current = true
        setAvailability('starting', { snapshot: current, errorMessage: null })
        const operation = await bridge.supervisor.startAll(crypto.randomUUID())
        if (operation.outcome !== 'succeeded') throw new Error(operation.message)
        current = await bridge.supervisor.status()
      }

      if (allServicesHealthy(current)) {
        await ensureRuntimeCompatibility(current, handshakeIdentity)
        setAvailability('online', { snapshot: current, errorMessage: null })
      } else {
        setAvailability('offline', {
          snapshot: current,
          errorMessage: describeUnavailableServices(current),
        })
      }
    } catch (error) {
      setAvailability('offline', {
        errorMessage: safeMessage(error),
      })
    } finally {
      requestInFlight.current = false
    }
  }, [setAvailability])

  useEffect(() => {
    void refresh(true)
    const timer = window.setInterval(() => {
      void refresh(true)
    }, BACKGROUND_RECHECK_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    return desktopEvents.subscribe(event => {
      if (event.event !== 'desktop:command') return
      const command = desktopMenuCommandSchema.safeParse(
        event.payload && typeof event.payload === 'object' && 'command' in event.payload
          ? event.payload.command
          : null,
      )
      if (command.success && command.data === 'open-system-logs') setLogsOpen(true)
    })
  }, [desktopEvents])

  const retry = useCallback(() => {
    automaticStartAttempted.current = false
    handshakeIdentity.current = null
    setAvailability('checking', { errorMessage: null })
    void refresh(true)
  }, [refresh, setAvailability])

  return (
    <>
      {children}
      {availability !== 'online' ? (
        <BackendStatusNotice
          availability={availability}
          snapshot={snapshot}
          errorMessage={errorMessage}
          onRetry={retry}
          onOpenLogs={() => setLogsOpen(true)}
        />
      ) : null}
      {logsOpen ? (
        <Suspense fallback={null}>
          <SystemLogViewer open onClose={() => setLogsOpen(false)} />
        </Suspense>
      ) : null}
    </>
  )
}

export function BackendStatusNotice({
  availability,
  snapshot,
  errorMessage,
  onRetry,
  onOpenLogs,
}: {
  availability: DesktopBackendAvailability
  snapshot: OperationsSnapshot | null
  errorMessage: string | null
  onRetry: () => void
  onOpenLogs: () => void
}) {
  const busy = availability === 'checking' || availability === 'starting'
  return (
    <aside className="desktop-backend-notice" data-state={availability} aria-live="polite">
      <span className="desktop-backend-notice__mark" aria-hidden="true" />
      <div className="desktop-backend-notice__copy">
        <strong>{backendAvailabilityTitle(availability)}</strong>
        <span>{errorMessage ?? backendAvailabilityDescription(availability)}</span>
        {snapshot ? (
          <small>{snapshot.services.map(service => (
            `${service.displayName}：${serviceStateLabel(service.state)}`
          )).join(' · ')}</small>
        ) : null}
      </div>
      <div className="desktop-backend-notice__actions">
        <button type="button" className="is-secondary" onClick={onOpenLogs}>系统日志</button>
        {busy ? (
          <span className="desktop-backend-notice__spinner" aria-hidden="true" />
        ) : (
          <button type="button" onClick={onRetry}>重新连接</button>
        )}
      </div>
    </aside>
  )
}

function allServicesHealthy(snapshot: OperationsSnapshot): boolean {
  return snapshot.services.length > 0
    && snapshot.services.every(service => service.state === 'healthy')
}

function describeConflicts(snapshot: OperationsSnapshot): string | null {
  const conflicts = snapshot.services.filter(service => service.state === 'conflict')
  if (conflicts.length === 0) return null
  return conflicts.map(service => `${service.displayName}：${service.healthMessage}`).join('；')
}

function describeUnavailableServices(snapshot: OperationsSnapshot): string {
  const unavailable = snapshot.services
    .filter(service => service.state !== 'healthy')
    .map(service => `${service.displayName}：${service.healthMessage}`)
  return unavailable.length > 0
    ? unavailable.join('；')
    : '后台服务尚未报告健康状态。'
}

function backendAvailabilityTitle(availability: DesktopBackendAvailability): string {
  if (availability === 'checking') return '正在检查本机服务'
  if (availability === 'starting') return '正在后台启动服务'
  return '当前处于离线工作台'
}

function backendAvailabilityDescription(availability: DesktopBackendAvailability): string {
  if (availability === 'checking') return '工作台已启动，正在连接本机监督器。'
  if (availability === 'starting') return '页面可继续浏览；依赖后端的操作会在服务就绪后恢复。'
  return '地图壳、布局和本地界面仍可使用；登录、数据与智能分析暂不可用。'
}

function serviceStateLabel(state: OperationsServiceSnapshot['state']): string {
  return ({
    stopped: '已停止',
    waiting_dependency: '等待依赖',
    starting: '启动中',
    healthy: '健康',
    degraded: '已降级',
    stopping: '停止中',
    restart_wait: '等待重启',
    failed: '失败',
    conflict: '端口冲突',
  })[state]
}

function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.replace(/[\r\n]+/gu, ' ').slice(0, 800)
  }
  return '无法连接本机后台服务。'
}

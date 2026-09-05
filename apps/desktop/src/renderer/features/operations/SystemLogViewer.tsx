// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机系统日志查看器
//
//   文件:       SystemLogViewer.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  operationsLogEntrySchema,
  operationsSnapshotSchema,
  type OperationsLogEntry,
  type OperationsLogFilter,
  type OperationsLogQuery,
  type OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  History,
  Pause,
  Play,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { normalizeBoundaryErrorMessage } from '../../api/errors'
import { requireDesktopBridge } from '../../api/transport'
import { useDesktopEventRouter } from '../../app/events/DesktopEventRouterContext'
import { Dialog } from '../../shared/components/GlassDialog'

const SERVICE_OPTIONS = [
  { value: 'all', label: '全部服务' },
  { value: 'infra', label: '原生基础设施' },
  { value: 'worker', label: '科学计算 Worker' },
  { value: 'api', label: '平台 API' },
] as const

const LEVEL_OPTIONS: ReadonlyArray<{ value: 'all' | OperationsLogLevel; label: string }> = [
  { value: 'all', label: '全部级别' },
  { value: 'error', label: '错误' },
  { value: 'warn', label: '警告' },
  { value: 'info', label: '信息' },
  { value: 'debug', label: '调试' },
  { value: 'unknown', label: '未分类' },
]

const CATEGORY_OPTIONS: ReadonlyArray<{ value: 'all' | OperationsLogCategory; label: string }> = [
  { value: 'all', label: '全部类别' },
  { value: 'lifecycle', label: '生命周期' },
  { value: 'health', label: '健康状态' },
  { value: 'request', label: '请求' },
  { value: 'agent', label: '智能体' },
  { value: 'model', label: '模型' },
  { value: 'tool', label: '工具' },
  { value: 'storage', label: '存储' },
  { value: 'security', label: '安全' },
  { value: 'ui', label: '界面' },
  { value: 'system', label: '系统' },
]

type ServiceFilter = typeof SERVICE_OPTIONS[number]['value']
type OperationsLogLevel = OperationsLogEntry['level']
type OperationsLogCategory = OperationsLogEntry['category']
type StreamFilter = 'all' | OperationsLogEntry['stream']
type RetentionFilter = 'all' | OperationsLogEntry['retention']
type ObservabilitySnapshot = OperationsSnapshot['observability']

export function SystemLogViewer({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const desktopEvents = useDesktopEventRouter()
  const [entries, setEntries] = useState<OperationsLogEntry[]>([])
  const [service, setService] = useState<ServiceFilter>('all')
  const [level, setLevel] = useState<'all' | OperationsLogLevel>('all')
  const [category, setCategory] = useState<'all' | OperationsLogCategory>('all')
  const [retention, setRetention] = useState<RetentionFilter>('operational')
  const [stream, setStream] = useState<StreamFilter>('all')
  const [eventName, setEventName] = useState('')
  const [correlationId, setCorrelationId] = useState('')
  const [search, setSearch] = useState('')
  const [includeSupervisor, setIncludeSupervisor] = useState(true)
  const [paused, setPaused] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [changingDiagnostics, setChangingDiagnostics] = useState(false)
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false)
  const [exportNotice, setExportNotice] = useState<string | null>(null)
  const [observability, setObservability] = useState<ObservabilitySnapshot | null>(null)
  const [now, setNow] = useState(Date.now())
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set())
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const scrollElement = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const previouslyFocusedElement = useRef<HTMLElement | null>(null)
  const pausedRef = useRef(false)
  const queryKeyRef = useRef('')
  const expiryRefreshRef = useRef<string | null>(null)
  const deferredSearch = useDeferredValue(search)
  const deferredEventName = useDeferredValue(eventName)
  const deferredCorrelationId = useDeferredValue(correlationId)

  const query = useMemo<OperationsLogQuery>(() => ({
    services: service === 'all' ? ['infra', 'worker', 'api'] : [service],
    levels: level === 'all' ? [] : [level],
    streams: stream === 'all' ? [] : [stream],
    categories: category === 'all' ? [] : [category],
    events: deferredEventName.trim() ? [deferredEventName.trim()] : [],
    retentions: retention === 'all' ? [] : [retention],
    correlationId: deferredCorrelationId.trim(),
    search: deferredSearch.trim(),
    includeSupervisor,
    afterSequence: null,
    tail: 2_000,
  }), [
    category,
    deferredCorrelationId,
    deferredEventName,
    deferredSearch,
    includeSupervisor,
    level,
    retention,
    service,
    stream,
  ])
  const subscriptionFilter = useMemo<OperationsLogFilter>(() => ({
    services: query.services,
    levels: query.levels,
    streams: query.streams,
    categories: query.categories,
    events: query.events,
    retentions: query.retentions,
    correlationId: query.correlationId,
    search: query.search,
    includeSupervisor: query.includeSupervisor,
    afterSequence: query.afterSequence,
  }), [query])
  const queryKey = useMemo(() => JSON.stringify(query), [query])
  queryKeyRef.current = queryKey

  const refresh = useCallback(async () => {
    if (!open) return
    const requestedQueryKey = queryKey
    setLoading(true)
    try {
      const page = await requireDesktopBridge().supervisor.logs(query)
      if (queryKeyRef.current !== requestedQueryKey) return
      setEntries(current => mergeLogEntries(current, page.entries))
      setErrorMessage(null)
    } catch (error) {
      if (queryKeyRef.current === requestedQueryKey) setErrorMessage(safeMessage(error))
    } finally {
      if (queryKeyRef.current === requestedQueryKey) setLoading(false)
    }
  }, [open, query, queryKey])

  const refreshObservability = useCallback(async () => {
    if (!open) return
    try {
      const snapshot = await requireDesktopBridge().supervisor.status()
      setObservability(snapshot.observability)
    } catch (error) {
      setErrorMessage(safeMessage(error))
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const bridge = requireDesktopBridge()
    let cancelled = false
    setEntries([])
    setExpandedKeys(new Set())
    setHistoryLoaded(false)
    setHistoryHasMore(false)
    setErrorMessage(null)
    const unsubscribeEvents = desktopEvents.subscribe(event => {
      if (event.event === 'supervisor:log') {
        const result = operationsLogEntrySchema.safeParse(event.payload)
        if (!result.success || pausedRef.current) return
        setEntries(current => mergeLogEntries(current, [result.data]))
        return
      }
      if (event.event === 'supervisor:snapshot') {
        const result = operationsSnapshotSchema.safeParse(event.payload)
        if (result.success) setObservability(result.data.observability)
      }
    })
    void (async () => {
      try {
        await bridge.supervisor.subscribeLogs(true, subscriptionFilter)
        const [page, snapshot] = await Promise.all([
          bridge.supervisor.logs(query),
          bridge.supervisor.status(),
        ])
        if (cancelled) return
        setEntries(current => mergeLogEntries(current, page.entries))
        setObservability(snapshot.observability)
        setErrorMessage(null)
      } catch (error) {
        if (!cancelled) setErrorMessage(safeMessage(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      unsubscribeEvents()
      void bridge.supervisor.subscribeLogs(false, subscriptionFilter).catch(() => undefined)
    }
  }, [desktopEvents, open, query, queryKey, subscriptionFilter])

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  useEffect(() => {
    const expiresAt = observability?.diagnostics.expiresAt
    if (!open || !observability?.diagnostics.enabled || !expiresAt) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [observability?.diagnostics.enabled, observability?.diagnostics.expiresAt, open])

  const diagnosticSeconds = diagnosticSecondsRemaining(observability, now)
  useEffect(() => {
    const expiresAt = observability?.diagnostics.expiresAt
    if (!open || !observability?.diagnostics.enabled || !expiresAt || diagnosticSeconds > 0) return
    if (expiryRefreshRef.current === expiresAt) return
    expiryRefreshRef.current = expiresAt
    void refreshObservability()
  }, [diagnosticSeconds, observability?.diagnostics.enabled, observability?.diagnostics.expiresAt, open, refreshObservability])

  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: index => {
      const entry = entries[index]
      return entry && expandedKeys.has(logEntryKey(entry)) ? 172 : 34
    },
    overscan: 24,
  })

  useEffect(() => {
    rowVirtualizer.measure()
  }, [expandedKeys, rowVirtualizer])

  useEffect(() => {
    if (!open || paused || entries.length === 0) return
    rowVirtualizer.scrollToIndex(entries.length - 1, { align: 'end' })
  }, [entries.length, open, paused, rowVirtualizer])

  if (!open) return null

  const togglePaused = () => {
    const next = !paused
    pausedRef.current = next
    setPaused(next)
    if (!next) void refresh()
  }

  const copyVisibleLogs = async () => {
    try {
      await requireDesktopBridge().clipboard.writeText(entries.map(formatLogLine).join('\n'))
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(safeMessage(error))
    }
  }

  const loadHistory = async () => {
    setLoadingHistory(true)
    try {
      const page = await requireDesktopBridge().supervisor.history(query)
      setEntries(current => mergeLogEntries(page.entries, current))
      setHistoryLoaded(true)
      setHistoryHasMore(page.hasMore)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(safeMessage(error))
    } finally {
      setLoadingHistory(false)
    }
  }

  const changeDiagnostics = async (enabled: boolean) => {
    setChangingDiagnostics(true)
    try {
      const diagnostics = enabled
        ? await requireDesktopBridge().supervisor.startDiagnostics()
        : await requireDesktopBridge().supervisor.stopDiagnostics()
      setObservability(current => current ? { ...current, diagnostics } : current)
      expiryRefreshRef.current = null
      setNow(Date.now())
      if (!observability) await refreshObservability()
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(safeMessage(error))
    } finally {
      setChangingDiagnostics(false)
    }
  }

  const exportDiagnostics = async () => {
    setExportingDiagnostics(true)
    try {
      const result = await requireDesktopBridge().supervisor.exportDiagnostics()
      setExportNotice(result.canceled
        ? null
        : `已导出 ${result.displayName ?? '诊断包'}（${result.entryCount} 条）`)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(safeMessage(error))
    } finally {
      setExportingDiagnostics(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={nextOpen => {
      if (!nextOpen) onClose()
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="gf-system-logs" />
        <Dialog.Content
          className="gf-system-logs__panel"
          onOpenAutoFocus={event => {
            previouslyFocusedElement.current = document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null
            event.preventDefault()
            searchInput.current?.focus()
          }}
          onCloseAutoFocus={event => {
            event.preventDefault()
            previouslyFocusedElement.current?.focus()
            previouslyFocusedElement.current = null
          }}
        >
          <header className="gf-system-logs__header">
            <div>
              <Dialog.Description asChild>
                <small>Desktop Main 与 Supervisor 本机事实流</small>
              </Dialog.Description>
              <Dialog.Title asChild>
                <h2>系统日志</h2>
              </Dialog.Title>
            </div>
            <div className="gf-system-logs__actions">
              <button type="button" title="复制当前脱敏结果" onClick={() => void copyVisibleLogs()}>
                <Copy size={14} aria-hidden="true" />
                复制
              </button>
              <button type="button" title={paused ? '继续跟随' : '暂停跟随'} onClick={togglePaused}>
                {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
                {paused ? '继续' : '暂停'}
              </button>
              <button type="button" title="刷新内存快照" onClick={() => void refresh()}>
                <RefreshCw size={14} className={loading ? 'is-spinning' : undefined} aria-hidden="true" />
                刷新
              </button>
              <Dialog.Close asChild>
                <button className="gf-system-logs__close" type="button" aria-label="关闭系统日志">
                  <X size={16} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
          </header>

          <div className="gf-system-logs__filters">
            <label>
              <span>服务</span>
              <select value={service} onChange={event => setService(event.currentTarget.value as ServiceFilter)}>
                {SERVICE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              <span>类别</span>
              <select value={category} onChange={event => setCategory(event.currentTarget.value as 'all' | OperationsLogCategory)}>
                {CATEGORY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              <span>级别</span>
              <select value={level} onChange={event => setLevel(event.currentTarget.value as 'all' | OperationsLogLevel)}>
                {LEVEL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              <span>保留层</span>
              <select value={retention} onChange={event => setRetention(event.currentTarget.value as RetentionFilter)}>
                <option value="operational">关键事件</option>
                <option value="diagnostic">内存诊断</option>
                <option value="all">全部记录</option>
              </select>
            </label>
            <label>
              <span>输出流</span>
              <select value={stream} onChange={event => setStream(event.currentTarget.value as StreamFilter)}>
                <option value="all">全部输出</option>
                <option value="stdout">标准输出</option>
                <option value="stderr">标准错误</option>
                <option value="supervisor">监督事件</option>
              </select>
            </label>
            <label>
              <span>事件</span>
              <input
                type="text"
                value={eventName}
                onChange={event => setEventName(event.currentTarget.value)}
                autoComplete="off"
                placeholder="model.request.completed"
              />
            </label>
            <label>
              <span>关联 ID</span>
              <input
                type="text"
                value={correlationId}
                onChange={event => setCorrelationId(event.currentTarget.value)}
                autoComplete="off"
                placeholder="运行、线程、请求或响应 ID"
              />
            </label>
            <label className="gf-system-logs__search">
              <span>搜索</span>
              <span>
                <Search size={14} aria-hidden="true" />
                <input
                  ref={searchInput}
                  name="system-log-search"
                  value={search}
                  onChange={event => setSearch(event.currentTarget.value)}
                  autoComplete="off"
                  placeholder="组件、事件或消息…"
                />
              </span>
            </label>
            <label className="gf-system-logs__check">
              <input
                type="checkbox"
                checked={includeSupervisor}
                onChange={event => setIncludeSupervisor(event.currentTarget.checked)}
              />
              本机主进程
            </label>
          </div>

          <div className="gf-system-logs__diagnostics">
            <div>
              <strong>详细诊断</strong>
              <span className="gf-system-logs__memory-badge">仅内存</span>
              <span>{diagnosticsDescription(observability, diagnosticSeconds)}</span>
              {observability ? (
                <span>
                  {formatBytes(observability.diagnostics.retainedBytes)} / {formatBytes(observability.diagnostics.maxBytes)}
                </span>
              ) : null}
            </div>
            <div>
              <span className={`gf-system-logs__persistence is-${observability?.persistence.state ?? 'unknown'}`}>
                {persistenceDescription(observability)}
              </span>
              {observability?.diagnostics.enabled ? (
                <button type="button" disabled={changingDiagnostics} onClick={() => void changeDiagnostics(false)}>
                  立即关闭
                </button>
              ) : (
                <button type="button" disabled={changingDiagnostics} onClick={() => void changeDiagnostics(true)}>
                  开启 30 分钟
                </button>
              )}
              <button type="button" disabled={loadingHistory} onClick={() => void loadHistory()}>
                <History size={13} aria-hidden="true" />
                {historyLoaded ? '重新加载历史' : '加载历史'}
              </button>
              <button type="button" disabled={exportingDiagnostics} onClick={() => void exportDiagnostics()}>
                <Download size={13} aria-hidden="true" />
                导出诊断包
              </button>
            </div>
          </div>

          <div className="gf-system-logs__status">
            <div className="gf-system-logs__summary">
              <span>{entries.length} 条 · 最多显示最近 2,000 条</span>
              <span>{paused ? '已暂停跟随' : '增量订阅中'}</span>
              {historyLoaded ? <span>{historyHasMore ? '已加载部分历史' : '历史已加载'}</span> : null}
              {exportNotice ? <span>{exportNotice}</span> : null}
            </div>
            {errorMessage ? (
              <div className="gf-system-logs__error" role="alert">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{errorMessage}</span>
              </div>
            ) : null}
          </div>

          <div className="gf-system-logs__table-head" aria-hidden="true">
            <span>时间</span>
            <span>级别</span>
            <span>服务 / 组件 / PID</span>
            <span>事件与消息（点击展开）</span>
          </div>
          <div className="gf-system-logs__viewport" ref={scrollElement}>
            {entries.length === 0 && !loading ? (
              <div className="gf-system-logs__empty">当前筛选条件下没有日志。</div>
            ) : (
              <div className="gf-system-logs__virtual" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                {rowVirtualizer.getVirtualItems().map(virtualRow => {
                  const entry = entries[virtualRow.index]
                  if (!entry) return null
                  const key = logEntryKey(entry)
                  const expanded = expandedKeys.has(key)
                  return (
                    <LogRow
                      key={key}
                      entry={entry}
                      expanded={expanded}
                      index={virtualRow.index}
                      measureElement={rowVirtualizer.measureElement}
                      onToggle={() => setExpandedKeys(current => toggleSetValue(current, key))}
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function LogRow({
  entry,
  expanded,
  index,
  measureElement,
  onToggle,
  style,
}: {
  entry: OperationsLogEntry
  expanded: boolean
  index: number
  measureElement: (node: Element | null) => void
  onToggle: () => void
  style: { transform: string }
}) {
  const source = [
    entry.serviceId ?? '本机',
    entry.component,
    entry.processId ? `PID ${entry.processId}` : null,
  ].filter(Boolean).join(' / ')
  return (
    <button
      ref={measureElement}
      type="button"
      className="gf-system-log-row"
      data-index={index}
      data-level={entry.level}
      data-expanded={expanded ? 'true' : 'false'}
      style={style}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
      <span className="gf-system-log-row__level">{levelLabel(entry.level)}</span>
      <span className="gf-system-log-row__source" title={source}>{source}</span>
      <span className="gf-system-log-row__message">
        {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        <small>{entry.event}</small>
        <span>{entry.message}</span>
      </span>
      {expanded ? <LogDetails entry={entry} /> : null}
    </button>
  )
}

function LogDetails({ entry }: { entry: OperationsLogEntry }) {
  const correlations = Object.entries(entry.correlation)
  const attributes = Object.entries(entry.attributes)
  return (
    <div className="gf-system-log-row__details">
      <dl>
        <div><dt>类别</dt><dd>{categoryLabel(entry.category)}</dd></div>
        <div><dt>保留层</dt><dd>{entry.retention === 'operational' ? '本机持久日志' : '仅内存诊断'}</dd></div>
        <div><dt>输出流</dt><dd>{entry.stream}</dd></div>
        {correlations.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
        {attributes.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}
      </dl>
      {entry.errorStack ? <pre>{entry.errorStack}</pre> : null}
    </div>
  )
}

function mergeLogEntries(
  existing: readonly OperationsLogEntry[],
  incoming: readonly OperationsLogEntry[],
): OperationsLogEntry[] {
  const byKey = new Map(existing.map(entry => [logEntryKey(entry), entry]))
  for (const entry of incoming) byKey.set(logEntryKey(entry), entry)
  return [...byKey.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.sequence - right.sequence)
    .slice(-2_000)
}

function logEntryKey(entry: OperationsLogEntry): string {
  return `${entry.serviceId ?? entry.component ?? 'system'}:${entry.sequence}:${entry.createdAt}`
}

function toggleSetValue(values: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(values)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function diagnosticSecondsRemaining(observability: ObservabilitySnapshot | null, now: number): number {
  const expiresAt = observability?.diagnostics.expiresAt
  if (!observability?.diagnostics.enabled || !expiresAt) return 0
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1_000))
}

function diagnosticsDescription(observability: ObservabilitySnapshot | null, seconds: number): string {
  if (!observability) return '正在读取状态…'
  if (!observability.diagnostics.enabled) return '日常飞行记录器：最近 10 分钟或 8 MB'
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `剩余 ${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function persistenceDescription(observability: ObservabilitySnapshot | null): string {
  if (!observability) return '持久化状态读取中'
  if (observability.persistence.state === 'healthy') return '日志持久化正常'
  return `日志持久化异常：${observability.persistence.message}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  })
}

function levelLabel(level: OperationsLogLevel): string {
  return ({
    debug: '调试',
    info: '信息',
    warn: '警告',
    error: '错误',
    unknown: '普通',
  })[level]
}

function categoryLabel(category: OperationsLogCategory): string {
  return CATEGORY_OPTIONS.find(option => option.value === category)?.label ?? category
}

function formatLogLine(entry: OperationsLogEntry): string {
  const source = [entry.serviceId ?? '本机', entry.component, entry.processId].filter(Boolean).join('/')
  const correlation = Object.entries(entry.correlation).map(([key, value]) => `${key}=${value}`).join(' ')
  const attributes = Object.entries(entry.attributes).map(([key, value]) => `${key}=${String(value)}`).join(' ')
  return [
    entry.createdAt,
    `[${entry.level}]`,
    `[${entry.category}]`,
    `[${entry.event}]`,
    `[${source}]`,
    entry.message,
    correlation,
    attributes,
    entry.errorStack ?? '',
  ].filter(Boolean).join(' ')
}

function safeMessage(error: unknown): string {
  return normalizeBoundaryErrorMessage(error, '读取系统日志失败。')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 500)
}

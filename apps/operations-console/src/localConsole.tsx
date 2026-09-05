// +-------------------------------------------------------------------------
//
//   地理智能平台 - 中文本地运维台
//
//   文件:       localConsole.tsx
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ConfirmInput, PasswordInput, TextInput, ThemeProvider } from '@inkjs/ui'
import type { OperationsClient } from '@geo-agent-platform/operations-supervisor/client'
import type {
  OperationsLogEntry,
  OperationsOperationResult,
  OperationsServiceId,
  OperationsServiceSnapshot,
  OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'
import type { AuditEvent } from '@geo-agent-platform/shared-types/platform'
import type { LocalManagedAccount } from '@geo-agent-platform/shared-types/local-operations'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'
import { Box, Text, render, useApp, useInput, usePaste, useWindowSize } from 'ink'

import { LocalConsoleMouseProvider, MouseRegion, type MouseRegionState } from './localConsoleMouse.js'
import { consolePalette, platformConsoleTheme } from './localConsoleTheme.js'
import type { LocalConsoleDataPlane, LocalConsoleOptions, LocalConsoleTab } from './localConsoleTypes.js'
import { createTerminalMouseController, type TerminalMouseSource } from './terminalMouse.js'

const ALL_SERVICES: OperationsServiceId[] = ['infra', 'worker', 'api']
const TAB_ORDER: LocalConsoleTab[] = ['services', 'logs', 'accounts', 'audit']
const LOG_LEVELS = ['all', 'error', 'warn', 'info', 'debug', 'unknown'] as const
type LogLevelFilter = (typeof LOG_LEVELS)[number]

type AccountAction = 'grant' | 'revoke' | 'enable' | 'disable' | 'sessions'
type ConsoleDialog =
  | { kind: 'help' }
  | { kind: 'search' }
  | { kind: 'confirm'; title: string; detail: string; expected: string | null; execute: () => Promise<void> }
  | {
      kind: 'create'
      step: 'email' | 'name' | 'password' | 'repeat' | 'confirm'
      email: string
      name: string
      password: string
    }
  | {
      kind: 'password'
      step: 'password' | 'repeat' | 'confirm'
      targetEmail: string
      password: string
    }

export async function runLocalConsole(options: LocalConsoleOptions): Promise<void> {
  const mouse = createTerminalMouseController()
  const instance = render(
    <ThemeProvider theme={platformConsoleTheme}>
      <LocalConsoleApp options={options} mouse={mouse} />
    </ThemeProvider>,
    {
      alternateScreen: true,
      exitOnCtrlC: false,
      patchConsole: false,
      stdin: mouse.stdin,
    },
  )
  mouse.activate()
  try {
    await instance.waitUntilExit()
  } finally {
    mouse.close()
  }
}

export function LocalConsoleApp({ options, mouse }: { options: LocalConsoleOptions; mouse?: TerminalMouseSource }) {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [tab, setTab] = useState<LocalConsoleTab>('services')
  const [client, setClient] = useState<OperationsClient | null>(null)
  const [connection, setConnection] = useState('正在连接监督器…')
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null)
  const [logs, setLogs] = useState<OperationsLogEntry[]>([])
  const logCursorRef = useRef<number | null>(null)
  const daemonIdRef = useRef<string | null>(null)
  const [serviceIndex, setServiceIndex] = useState(0)
  const [accountIndex, setAccountIndex] = useState(0)
  const [auditIndex, setAuditIndex] = useState(0)
  const [accounts, setAccounts] = useState<LocalManagedAccount[]>([])
  const [audits, setAudits] = useState<AuditEvent[]>([])
  const [dataPlaneError, setDataPlaneError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('就绪。q / Ctrl+C 仅分离，不停止服务。')
  const [busy, setBusy] = useState<string | null>(null)
  const [dialog, setDialog] = useState<ConsoleDialog | null>(null)
  const [search, setSearch] = useState('')
  const [logPaused, setLogPaused] = useState(false)
  const [pausedSequence, setPausedSequence] = useState<number | null>(null)
  const [logLevel, setLogLevel] = useState<LogLevelFilter>('all')
  const [logService, setLogService] = useState<OperationsServiceId | 'all'>('all')
  const [wrapLogs, setWrapLogs] = useState(false)
  const [showInspector, setShowInspector] = useState(false)
  const [logScrollOffset, setLogScrollOffset] = useState(0)
  const dataPlaneRef = useRef<Promise<LocalConsoleDataPlane> | null>(null)

  const ensureDataPlane = useCallback((): Promise<LocalConsoleDataPlane> => {
    dataPlaneRef.current ??= options.openDataPlane().catch(error => {
      dataPlaneRef.current = null
      throw error
    })
    return dataPlaneRef.current
  }, [options])

  const loadAccounts = useCallback(async (): Promise<void> => {
    try {
      const plane = await ensureDataPlane()
      const next = await plane.accounts.listAccounts()
      setAccounts(next)
      setAccountIndex(index => clampIndex(index, next.length))
      setDataPlaneError(null)
    } catch (error) {
      setDataPlaneError(`账户数据不可用：${safeMessage(error)}`)
    }
  }, [ensureDataPlane])

  const loadAudits = useCallback(async (): Promise<void> => {
    try {
      const plane = await ensureDataPlane()
      const next = await plane.listAuditEvents(300)
      setAudits(next)
      setAuditIndex(index => clampIndex(index, next.length))
      setDataPlaneError(null)
    } catch (error) {
      setDataPlaneError(`审计数据不可用：${safeMessage(error)}`)
    }
  }, [ensureDataPlane])

  useEffect(() => {
    if (tab === 'accounts') void loadAccounts()
    if (tab === 'audit') void loadAudits()
  }, [loadAccounts, loadAudits, tab])

  useEffect(() => () => {
    const pending = dataPlaneRef.current
    if (pending) void pending.then(plane => plane.close()).catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    let activeClient: OperationsClient | null = null
    let reconnectTimer: NodeJS.Timeout | null = null
    const connect = async (): Promise<void> => {
      setConnection('正在连接监督器…')
      try {
        const next = await options.connectSupervisor()
        if (cancelled) {
          next.close()
          return
        }
        activeClient = next
        setClient(next)
        setConnection('已连接')
        const replaceLogs = daemonIdRef.current !== null && daemonIdRef.current !== next.server.daemonId
        if (replaceLogs) logCursorRef.current = null
        daemonIdRef.current = next.server.daemonId
        const resumeAfter = logCursorRef.current
        const pendingLive: OperationsLogEntry[] = []
        let catchingUp = true
        const disposeEvents = next.onEvent(event => {
          if (event.event === 'snapshot') setSnapshot(event.snapshot)
          if (event.event === 'log') {
            if (catchingUp) {
              pendingLive.push(event.entry)
              if (pendingLive.length > 1_500) pendingLive.splice(0, pendingLive.length - 1_500)
            }
            else {
              logCursorRef.current = Math.max(logCursorRef.current ?? 0, event.entry.sequence)
              setLogs(current => mergeLogEntries(current, [event.entry]))
            }
          }
          if (event.event === 'operation') setFeedback(operationFeedback(event.operation))
        })
        const disposeDisconnected = next.onDisconnected(error => {
          disposeEvents()
          disposeDisconnected()
          if (cancelled || activeClient !== next) return
          activeClient = null
          setClient(null)
          setConnection(`连接中断：${safeMessage(error)}；2 秒后重连`)
          reconnectTimer = setTimeout(() => void connect(), 2_000)
        })
        await next.subscribe({
          metrics: true,
          logs: true,
          logFilter: {
            services: ALL_SERVICES,
            levels: [],
            streams: [],
            categories: [],
            events: [],
            retentions: [],
            correlationId: '',
            search: '',
            includeSupervisor: true,
            afterSequence: resumeAfter,
          },
        })
        const initialSnapshot = await next.status()
        const caughtUp: OperationsLogEntry[] = []
        let page = await next.logs(ALL_SERVICES, 300, {
          includeSupervisor: true,
          afterSequence: resumeAfter,
        })
        caughtUp.push(...page.entries)
        while (resumeAfter !== null && page.hasMore && page.nextCursor !== null) {
          const previousCursor = page.nextCursor
          page = await next.logs(ALL_SERVICES, 300, {
            includeSupervisor: true,
            afterSequence: previousCursor,
          })
          if (page.nextCursor === previousCursor) break
          caughtUp.push(...page.entries)
        }
        if (cancelled || activeClient !== next) return
        catchingUp = false
        const reconciled = mergeLogEntries(caughtUp, pendingLive)
        logCursorRef.current = reconciled.at(-1)?.sequence ?? resumeAfter
        setSnapshot(initialSnapshot)
        setLogs(current => mergeLogEntries(replaceLogs ? [] : current, reconciled))
      } catch (error) {
        if (cancelled) return
        const failedClient = activeClient
        activeClient = null
        failedClient?.close()
        setClient(null)
        setConnection(`无法连接：${safeMessage(error)}；2 秒后重试`)
        reconnectTimer = setTimeout(() => void connect(), 2_000)
      }
    }
    void connect()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      activeClient?.close()
    }
  }, [options])

  const selectedService = snapshot?.services[serviceIndex] ?? null
  const selectedAccount = accounts[accountIndex] ?? null

  const runOperation = useCallback(async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(label)
    try {
      await action()
      setFeedback(`${label}完成。`)
    } catch (error) {
      setFeedback(`${label}失败：${safeMessage(error)}`)
    } finally {
      setBusy(null)
      setDialog(null)
    }
  }, [])

  const executeServiceAction = useCallback(async (
    action: 'start' | 'stop' | 'restart',
    service: OperationsServiceSnapshot,
  ): Promise<void> => {
    if (!client) throw new Error('监督器尚未连接。')
    const result = await client.operate({ action, target: service.serviceId })
    assertOperationSucceeded(result)
    setFeedback(operationFeedback(result))
  }, [client])

  const requestServiceAction = useCallback((action: 'start' | 'stop' | 'restart'): void => {
    if (!selectedService) {
      setFeedback('尚未取得服务状态。')
      return
    }
    if (action === 'start') {
      void runOperation(`启动${selectedService.displayName}`, () => executeServiceAction(action, selectedService))
      return
    }
    const dangerous = selectedService.serviceId === 'infra'
    setDialog({
      kind: 'confirm',
      title: `${action === 'stop' ? '停止' : '重启'} ${selectedService.displayName}`,
      detail: serviceImpact(selectedService, snapshot),
      expected: dangerous ? selectedService.displayName : null,
      execute: () => runOperation(
        `${action === 'stop' ? '停止' : '重启'}${selectedService.displayName}`,
        () => executeServiceAction(action, selectedService),
      ),
    })
  }, [executeServiceAction, runOperation, selectedService, snapshot])

  const refreshAccountViews = useCallback(async (): Promise<void> => {
    await loadAccounts()
    if (tab === 'audit') await loadAudits()
  }, [loadAccounts, loadAudits, tab])

  const executeAccountAction = useCallback(async (
    action: AccountAction,
    account: LocalManagedAccount,
  ): Promise<void> => {
    const plane = await ensureDataPlane()
    if (action === 'grant') await plane.accounts.grantPlatformAdmin(account.email)
    if (action === 'revoke') await plane.accounts.revokePlatformAdmin(account.email)
    if (action === 'enable') await plane.accounts.setAccountEnabled(account.email, true)
    if (action === 'disable') await plane.accounts.setAccountEnabled(account.email, false)
    if (action === 'sessions') await plane.accounts.revokeSessions(account.email)
    await refreshAccountViews()
  }, [ensureDataPlane, refreshAccountViews])

  const requestAccountAction = useCallback((action: AccountAction): void => {
    if (!selectedAccount) {
      setFeedback('当前没有可操作的认证账户。')
      return
    }
    if (action === 'enable') {
      void runOperation(`启用 ${selectedAccount.email}`, () => executeAccountAction(action, selectedAccount))
      return
    }
    const labels: Record<Exclude<AccountAction, 'enable'>, string> = {
      grant: '授予平台管理员',
      revoke: '撤销平台管理员',
      disable: '禁用账户并撤销会话',
      sessions: '撤销全部登录会话',
    }
    const dangerous = action === 'revoke' || action === 'disable'
    setDialog({
      kind: 'confirm',
      title: `${labels[action]} · ${selectedAccount.email}`,
      detail: dangerous ? '此操作会立即改变权限或登录状态，并写入本机运维审计。' : '操作将通过 Better Auth 官方 Admin API 执行。',
      expected: dangerous ? selectedAccount.email : null,
      execute: () => runOperation(labels[action], () => executeAccountAction(action, selectedAccount)),
    })
  }, [executeAccountAction, runOperation, selectedAccount])

  const visibleLogs = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    return logs.filter(entry => {
      if (pausedSequence !== null && entry.sequence > pausedSequence) return false
      if (logService !== 'all' && entry.serviceId !== logService) return false
      if (logLevel !== 'all' && entry.level !== logLevel) return false
      return !normalizedSearch || entry.message.toLowerCase().includes(normalizedSearch)
    })
  }, [logLevel, logService, logs, pausedSequence, search])

  useEffect(() => {
    const capacity = calculateLogCapacity(tab, columns, rows, showInspector)
    setLogScrollOffset(offset => Math.min(offset, Math.max(0, visibleLogs.length - capacity)))
  }, [columns, rows, showInspector, tab, visibleLogs.length])

  const toggleLogFollow = useCallback((): void => {
    setLogPaused(current => {
      const next = !current
      setPausedSequence(next ? (logs.at(-1)?.sequence ?? 0) : null)
      if (!next) setLogScrollOffset(0)
      return next
    })
  }, [logs])

  const scrollLogWindow = useCallback((direction: -1 | 1, distance = 3): void => {
    if (direction < 0) {
      setLogPaused(true)
      setPausedSequence(current => current ?? (logs.at(-1)?.sequence ?? 0))
    }
    setLogScrollOffset(current => {
      const delta = direction < 0 ? distance : -distance
      const capacity = calculateLogCapacity(tab, columns, rows, showInspector)
      return Math.max(0, Math.min(Math.max(0, visibleLogs.length - capacity), current + delta))
    })
  }, [columns, logs, rows, showInspector, tab, visibleLogs.length])

  const cycleTab = useCallback((direction: -1 | 1): void => {
    setTab(current => {
      const index = TAB_ORDER.indexOf(current)
      return TAB_ORDER[(index + direction + TAB_ORDER.length) % TAB_ORDER.length] ?? 'services'
    })
  }, [])

  const requestShutdown = useCallback((): void => {
    setDialog({
      kind: 'confirm',
      title: '停止全部服务并关闭监督器',
      detail: '这与普通分离不同：所有服务都会停止，监督后台也会退出。',
      expected: '停止全部',
      execute: () => runOperation('停止全部并退出', async () => {
        if (!client) throw new Error('监督器尚未连接。')
        assertOperationSucceeded(await client.shutdown())
        exit()
      }),
    })
  }, [client, exit, runOperation])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit()
      return
    }
    if (input === 'q') {
      exit()
      return
    }
    if (input === 'Q') {
      requestShutdown()
      return
    }
    if (input === '?') {
      setDialog({ kind: 'help' })
      return
    }
    if (/^[1-4]$/u.test(input)) {
      const next = TAB_ORDER[Number(input) - 1]
      if (next) setTab(next)
      return
    }
    if (key.tab) {
      cycleTab(key.shift ? -1 : 1)
      return
    }
    if (key.upArrow) {
      if (tab === 'services') setServiceIndex(index => Math.max(0, index - 1))
      if (tab === 'logs') scrollLogWindow(-1, 1)
      if (tab === 'accounts') setAccountIndex(index => Math.max(0, index - 1))
      if (tab === 'audit') setAuditIndex(index => Math.max(0, index - 1))
      return
    }
    if (key.downArrow) {
      if (tab === 'services') setServiceIndex(index => Math.min((snapshot?.services.length ?? 1) - 1, index + 1))
      if (tab === 'logs') scrollLogWindow(1, 1)
      if (tab === 'accounts') setAccountIndex(index => Math.min(Math.max(0, accounts.length - 1), index + 1))
      if (tab === 'audit') setAuditIndex(index => Math.min(Math.max(0, audits.length - 1), index + 1))
      return
    }
    if (key.pageUp || key.pageDown) {
      const direction = key.pageUp ? -1 : 1
      const pageSize = Math.max(5, rows - 12)
      if (tab === 'logs') scrollLogWindow(direction, pageSize)
      if (tab === 'accounts') setAccountIndex(index => clampIndex(index + direction * pageSize, accounts.length))
      if (tab === 'audit') setAuditIndex(index => clampIndex(index + direction * pageSize, audits.length))
      return
    }
    if (key.home || key.end) {
      const last = key.end
      if (tab === 'logs') {
        if (last) {
          setLogScrollOffset(0)
          setLogPaused(false)
          setPausedSequence(null)
        } else scrollLogWindow(-1, Math.max(0, visibleLogs.length - 1))
      }
      if (tab === 'services') setServiceIndex(last ? Math.max(0, (snapshot?.services.length ?? 1) - 1) : 0)
      if (tab === 'accounts') setAccountIndex(last ? Math.max(0, accounts.length - 1) : 0)
      if (tab === 'audit') setAuditIndex(last ? Math.max(0, audits.length - 1) : 0)
      return
    }
    if (tab === 'services') {
      if (key.return) setShowInspector(value => !value)
      if (input.toLowerCase() === 's') requestServiceAction('start')
      if (input.toLowerCase() === 'x') requestServiceAction('stop')
      if (input.toLowerCase() === 'r') requestServiceAction('restart')
    }
    if (tab === 'logs' || tab === 'services') {
      if (input === '/') setDialog({ kind: 'search' })
      if (input.toLowerCase() === 'f') toggleLogFollow()
      if (input.toLowerCase() === 'w') setWrapLogs(value => !value)
      if (input.toLowerCase() === 'l') {
        setLogLevel(value => LOG_LEVELS[(LOG_LEVELS.indexOf(value) + 1) % LOG_LEVELS.length] ?? 'all')
      }
      if (input === '[' || input === ']') setLogService(value => cycleService(value, input === ']' ? 1 : -1))
    }
    if (tab === 'accounts') {
      if (input.toLowerCase() === 'u') void loadAccounts()
      if (input.toLowerCase() === 'n') setDialog({ kind: 'create', step: 'email', email: '', name: '', password: '' })
      if (input.toLowerCase() === 'g') requestAccountAction('grant')
      if (input.toLowerCase() === 'x') requestAccountAction('revoke')
      if (input.toLowerCase() === 'e' && selectedAccount) {
        requestAccountAction(selectedAccount.banned || selectedAccount.platformStatus === 'disabled' ? 'enable' : 'disable')
      }
      if (input.toLowerCase() === 'v') requestAccountAction('sessions')
      if (input.toLowerCase() === 'p' && selectedAccount) {
        setDialog({ kind: 'password', step: 'password', targetEmail: selectedAccount.email, password: '' })
      }
    }
    if (tab === 'audit' && input.toLowerCase() === 'u') void loadAudits()
  }, { isActive: dialog === null && busy === null })

  const submitCreate = useCallback((value: string): void => {
    if (!dialog || dialog.kind !== 'create') return
    if (dialog.step === 'email') {
      setDialog({ ...dialog, email: value.trim().toLowerCase(), step: 'name' })
    } else if (dialog.step === 'name') {
      setDialog({ ...dialog, name: value.trim(), step: 'password' })
    } else if (dialog.step === 'password') {
      setDialog({ ...dialog, password: value, step: 'repeat' })
    } else if (dialog.step === 'repeat') {
      if (value !== dialog.password) {
        setFeedback('两次输入的密码不一致。')
        setDialog({ ...dialog, password: '', step: 'password' })
      } else {
        setDialog({ ...dialog, step: 'confirm' })
      }
    } else if (value.trim().toLowerCase() === dialog.email) {
      void runOperation(`创建管理员 ${dialog.email}`, async () => {
        const plane = await ensureDataPlane()
        await plane.accounts.createPlatformAdmin({
          email: dialog.email,
          password: dialog.password,
          displayName: dialog.name,
        })
        await refreshAccountViews()
      })
    } else {
      setFeedback('确认邮箱不匹配，操作未执行。')
    }
  }, [dialog, ensureDataPlane, refreshAccountViews, runOperation])

  const submitPassword = useCallback((value: string): void => {
    if (!dialog || dialog.kind !== 'password') return
    if (dialog.step === 'password') {
      setDialog({ ...dialog, password: value, step: 'repeat' })
    } else if (dialog.step === 'repeat') {
      if (value !== dialog.password) {
        setFeedback('两次输入的密码不一致。')
        setDialog({ ...dialog, password: '', step: 'password' })
      } else {
        setDialog({ ...dialog, step: 'confirm' })
      }
    } else if (value.trim().toLowerCase() === dialog.targetEmail) {
      void runOperation(`重置 ${dialog.targetEmail} 的密码`, async () => {
        const plane = await ensureDataPlane()
        await plane.accounts.resetPassword(dialog.targetEmail, dialog.password)
        await refreshAccountViews()
      })
    } else {
      setFeedback('确认邮箱不匹配，操作未执行。')
    }
  }, [dialog, ensureDataPlane, refreshAccountViews, runOperation])

  if (columns < 80 || rows < 24) {
    return <LocalConsoleMouseProvider source={mouse}>
      <SizeWarning columns={columns} rows={rows} onExit={exit} />
    </LocalConsoleMouseProvider>
  }

  return (
    <LocalConsoleMouseProvider source={mouse}>
      <Box width={columns} height={rows} flexDirection="column" backgroundColor={tone(consolePalette.canvas)}>
        <ConsoleHeader snapshot={snapshot} connection={connection} mouseEnabled={Boolean(mouse?.enabled)} columns={columns} />
        <TabBar active={tab} onSelect={setTab} onHelp={() => setDialog({ kind: 'help' })} />
        <Box flexGrow={1} flexShrink={1} minHeight={0} paddingX={1} paddingY={1}>
        {dialog
          ? <DialogView
              dialog={dialog}
              minPasswordLength={options.minPasswordLength}
              onCancel={() => setDialog(null)}
              onSearch={value => { setSearch(value); setDialog(null) }}
              onCreateSubmit={submitCreate}
              onPasswordSubmit={submitPassword}
            />
          : tab === 'services'
            ? <ServicesView
                snapshot={snapshot}
                selectedIndex={serviceIndex}
                logs={visibleLogs}
                columns={columns}
                rows={rows}
                showInspector={showInspector}
                wrapLogs={wrapLogs}
                logOffset={logScrollOffset}
                logPaused={logPaused}
                onSelect={setServiceIndex}
                onAction={requestServiceAction}
                onToggleInspector={() => setShowInspector(value => !value)}
                onScrollLogs={scrollLogWindow}
              />
            : tab === 'logs'
              ? <LogsView
                  entries={visibleLogs}
                  columns={columns}
                  rows={Math.max(5, rows - 11)}
                  paused={logPaused}
                  search={search}
                  level={logLevel}
                  service={logService}
                  wrap={wrapLogs}
                  offset={logScrollOffset}
                  onToggleFollow={toggleLogFollow}
                  onToggleWrap={() => setWrapLogs(value => !value)}
                  onCycleLevel={() => setLogLevel(value => LOG_LEVELS[(LOG_LEVELS.indexOf(value) + 1) % LOG_LEVELS.length] ?? 'all')}
                  onCycleService={() => setLogService(value => cycleService(value, 1))}
                  onSearch={() => setDialog({ kind: 'search' })}
                  onClearSearch={() => setSearch('')}
                  onScroll={scrollLogWindow}
                />
              : tab === 'accounts'
                ? <AccountsView
                    accounts={accounts}
                    columns={columns}
                    selectedIndex={accountIndex}
                    error={dataPlaneError}
                    rows={Math.max(5, rows - 11)}
                    onSelect={setAccountIndex}
                    onScroll={direction => setAccountIndex(index => clampIndex(index + direction * 3, accounts.length))}
                    onCreate={() => setDialog({ kind: 'create', step: 'email', email: '', name: '', password: '' })}
                    onAction={requestAccountAction}
                    onPassword={() => selectedAccount && setDialog({ kind: 'password', step: 'password', targetEmail: selectedAccount.email, password: '' })}
                    onRefresh={() => void loadAccounts()}
                  />
                : <AuditView
                    audits={audits}
                    columns={columns}
                    selectedIndex={auditIndex}
                    error={dataPlaneError}
                    rows={Math.max(5, rows - 11)}
                    onSelect={setAuditIndex}
                    onScroll={direction => setAuditIndex(index => clampIndex(index + direction * 3, audits.length))}
                    onRefresh={() => void loadAudits()}
                  />}
        </Box>
        <ConsoleFooter
          tab={tab}
          feedback={busy ?? feedback}
          columns={columns}
          mouseEnabled={Boolean(mouse?.enabled)}
          onDetach={exit}
          onShutdown={requestShutdown}
        />
      </Box>
    </LocalConsoleMouseProvider>
  )
}

function mergeLogEntries(
  current: readonly OperationsLogEntry[],
  incoming: readonly OperationsLogEntry[],
): OperationsLogEntry[] {
  const bySequence = new Map<number, OperationsLogEntry>()
  for (const entry of current) bySequence.set(entry.sequence, entry)
  for (const entry of incoming) bySequence.set(entry.sequence, entry)
  return [...bySequence.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-1_500)
}

function ConsoleHeader({ snapshot, connection, mouseEnabled, columns }: {
  snapshot: OperationsSnapshot | null
  connection: string
  mouseEnabled: boolean
  columns: number
}) {
  const compact = columns < 100
  const connectionLabel = connection === '已连接'
    ? compact
      ? `● 在线 · 鼠标${mouseEnabled ? '开' : '关'}`
      : `● 已连接 · 鼠标${mouseEnabled ? '开启' : '不可用'}`
    : `◐ ${connection}`
  const identity = snapshot
    ? `${snapshot.host.hostname} · ${snapshot.host.profile === 'production' ? '生产' : '开发'} · PID ${snapshot.host.supervisorPid}`
    : '等待监督状态'
  const metrics = `CPU ${formatMetric(snapshot?.host.cpuPercent.value ?? null, '%')} · 内存 ${formatPercent(snapshot?.host.memoryUsedBytes.value ?? null, snapshot?.host.memoryTotalBytes.value ?? null)} · 磁盘 ${formatPercent(snapshot?.host.runtimeDiskUsedBytes.value ?? null, snapshot?.host.runtimeDiskTotalBytes.value ?? null)}`
  if (compact) {
    return (
      <Box width="100%" flexShrink={0} flexDirection="column" borderStyle="round" borderColor={tone(consolePalette.border)} paddingX={1}>
        <Box width="100%">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text wrap="truncate-end" bold color={tone(consolePalette.focus)}>◆ {PRODUCT_CODENAME} 本地运维台</Text>
          </Box>
          <Text color={tone(connection === '已连接' ? consolePalette.healthy : consolePalette.warning)}>{connectionLabel}</Text>
        </Box>
        <Text wrap="truncate-end" color={tone(consolePalette.muted)}>{identity} · {metrics}</Text>
      </Box>
    )
  }
  return (
    <Box width="100%" flexShrink={0} borderStyle="round" borderColor={tone(consolePalette.border)} paddingX={1} justifyContent="space-between">
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text bold color={tone(consolePalette.focus)}>◆ {PRODUCT_CODENAME} 本地运维台</Text>
        <Text wrap="truncate-end" color={tone(consolePalette.muted)}>{identity}</Text>
      </Box>
      <Box flexDirection="column" alignItems="flex-end" flexShrink={0}>
        <Text color={tone(connection === '已连接' ? consolePalette.healthy : consolePalette.warning)}>
          {connectionLabel}
        </Text>
        <Text color={tone(consolePalette.text)}>{metrics}</Text>
      </Box>
    </Box>
  )
}

function TabBar({ active, onSelect, onHelp }: {
  active: LocalConsoleTab
  onSelect: (tab: LocalConsoleTab) => void
  onHelp: () => void
}) {
  const labels: Array<[LocalConsoleTab, string]> = [
    ['services', '1 服务'], ['logs', '2 日志'], ['accounts', '3 账户'], ['audit', '4 审计'],
  ]
  return (
    <Box flexShrink={0} paddingX={2} gap={1} aria-role="tablist">
      {labels.map(([tab, label]) => (
        <MouseRegion
          key={tab}
          priority={20}
          aria-role="tab"
          aria-state={{ selected: active === tab }}
          onClick={() => onSelect(tab)}
        >
          {state => <Text
            bold={active === tab || state.hovered}
            color={tone(active === tab ? consolePalette.canvas : state.hovered ? consolePalette.text : consolePalette.muted)}
            backgroundColor={tone(active === tab ? consolePalette.focus : state.hovered ? consolePalette.selected : consolePalette.panel)}
          > {label} </Text>}
        </MouseRegion>
      ))}
      <Box flexGrow={1} />
      <ActionButton label="? 帮助" onPress={onHelp} subtle />
    </Box>
  )
}

function ServicesView(input: {
  snapshot: OperationsSnapshot | null
  selectedIndex: number
  logs: OperationsLogEntry[]
  columns: number
  rows: number
  showInspector: boolean
  wrapLogs: boolean
  logOffset: number
  logPaused: boolean
  onSelect: (index: number) => void
  onAction: (action: 'start' | 'stop' | 'restart') => void
  onToggleInspector: () => void
  onScrollLogs: (direction: -1 | 1, distance?: number) => void
}) {
  const services = input.snapshot?.services ?? []
  const selected = services[input.selectedIndex] ?? null
  const wide = input.columns >= 140
  const compact = input.columns < 100
  const showInspector = wide || input.showInspector
  const servicePanelRows = showInspector ? 14 : 9
  const logMargin = input.rows >= 26 ? 1 : 0
  const logRows = Math.max(1, input.rows - 14 - servicePanelRows - logMargin)
  const logWindow = selectLogWindow(input.logs, logRows, input.logOffset)
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box height={servicePanelRows} flexShrink={0}>
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={tone(consolePalette.border)} paddingX={1}>
          <Box gap={1}>
            <Text bold color={tone(consolePalette.focus)}>服务操作</Text>
            <ActionButton label="启动" onPress={() => input.onAction('start')} disabled={!selected} intent="healthy" />
            <ActionButton label="停止" onPress={() => input.onAction('stop')} disabled={!selected} intent="danger" />
            <ActionButton label="重启" onPress={() => input.onAction('restart')} disabled={!selected} intent="warning" />
            <ActionButton label="详情" onPress={input.onToggleInspector} active={showInspector} />
          </Box>
          {showInspector && !wide
            ? <ServiceInspectorBody service={selected} compact />
            : <>
                <ServiceTableHeader wide={wide} compact={compact} />
                {services.length
                  ? services.map((service, index) => (
                      <MouseRegion key={service.serviceId} width="100%" priority={10} onClick={() => input.onSelect(index)}>
                        {state => <ServiceRow service={service} selected={index === input.selectedIndex} hovered={state.hovered} wide={wide} compact={compact} />}
                      </MouseRegion>
                    ))
                  : <Text color={tone(consolePalette.warning)}>◐ 正在等待监督器快照…</Text>}
              </>}
        </Box>
        {wide && <ServiceInspector service={selected} width={46} />}
      </Box>
      <MouseRegion
        marginTop={logMargin}
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderColor={tone(consolePalette.border)}
        paddingX={1}
        priority={1}
        onWheel={direction => input.onScrollLogs(direction)}
      >
        <Text bold color={tone(input.logPaused ? consolePalette.warning : consolePalette.focus)}>
          {input.logPaused ? 'Ⅱ 日志已暂停' : '▶ 实时日志'} · {logWindow.label} · 滚轮浏览
        </Text>
        <LogLines entries={logWindow.entries} wrap={input.wrapLogs} />
      </MouseRegion>
    </Box>
  )
}

function ServiceTableHeader({ wide, compact }: { wide: boolean; compact: boolean }) {
  return (
    <Box>
      <Cell width={compact ? 11 : 13} muted>状态</Cell><Cell width={compact ? 13 : 15} muted>服务</Cell><Cell width={compact ? 7 : 8} muted>PID</Cell>
      <Cell width={compact ? 8 : 10} muted>CPU</Cell><Cell width={compact ? 10 : 12} muted>内存</Cell>
      {wide && <><Cell width={12} muted>运行时间</Cell><Cell width={7} muted>重启</Cell></>}
      <Cell muted>健康</Cell>
    </Box>
  )
}

function ServiceRow({ service, selected, hovered, wide, compact }: {
  service: OperationsServiceSnapshot
  selected: boolean
  hovered: boolean
  wide: boolean
  compact: boolean
}) {
  const presentation = servicePresentation(service)
  return (
    <Box width="100%" backgroundColor={tone(selected ? consolePalette.selected : hovered ? consolePalette.panelRaised : consolePalette.canvas)}>
      <Cell width={compact ? 11 : 13} color={presentation.color}>{presentation.symbol} {presentation.label}</Cell>
      <Cell width={compact ? 13 : 15} bold={selected}>{service.displayName}</Cell>
      <Cell width={compact ? 7 : 8}>{service.pid ?? '—'}</Cell>
      <Cell width={compact ? 8 : 10}>{formatMetric(service.cpuPercent.value, '%')}</Cell>
      <Cell width={compact ? 10 : 12}>{formatBytes(service.memoryBytes.value)}</Cell>
      {wide && <><Cell width={12}>{formatDuration(service.uptimeSeconds)}</Cell><Cell width={7}>{service.restartCount}</Cell></>}
      <Cell color={service.state === 'healthy' ? consolePalette.muted : presentation.color}>{service.healthMessage}</Cell>
    </Box>
  )
}

function ServiceInspector({ service, width }: { service: OperationsServiceSnapshot | null; width: number }) {
  return (
    <Box width={width} marginLeft={1} flexDirection="column" borderStyle="round" borderColor={tone(consolePalette.border)} paddingX={1}>
      <ServiceInspectorBody service={service} />
    </Box>
  )
}

function ServiceInspectorBody({ service, compact = false }: { service: OperationsServiceSnapshot | null; compact?: boolean }) {
  return <>
    <Text bold color={tone(consolePalette.focus)}>服务检查器</Text>
    {service
      ? <>
          <Text wrap="truncate-end" bold>{servicePresentation(service).symbol} {service.displayName} · {servicePresentation(service).label}</Text>
          <Text wrap="truncate-end" color={tone(consolePalette.muted)}>{service.description}</Text>
          <Text wrap="truncate-end">PID：{service.pid ?? '—'} · 运行 {formatDuration(service.uptimeSeconds)} · 重启 {service.restartCount}</Text>
          <Text wrap="truncate-end">CPU：{metricDetail(service.cpuPercent, '%')} · 内存：{metricBytesDetail(service.memoryBytes)}</Text>
          {!compact && <Text wrap="truncate-end">启动：{service.startedAt ? shortDate(service.startedAt) : '—'} · 退出码：{service.lastExitCode ?? '—'}</Text>}
          <Text wrap="truncate-end" color={tone(service.state === 'healthy' ? consolePalette.healthy : consolePalette.warning)}>探针：{service.healthMessage}</Text>
          <Text wrap="truncate-end">依赖阻塞：{service.blockedBy.length ? service.blockedBy.join('、') : '无'}</Text>
          {service.serviceId === 'infra'
            ? <Text wrap="truncate-end">组件：原生 PostgreSQL/PostGIS</Text>
            : null}
        </>
      : <Text color={tone(consolePalette.muted)}>选择服务后显示探针与进程摘要。</Text>}
  </>
}

function LogsView(input: {
  entries: OperationsLogEntry[]
  columns: number
  rows: number
  paused: boolean
  search: string
  level: LogLevelFilter
  service: OperationsServiceId | 'all'
  wrap: boolean
  offset: number
  onToggleFollow: () => void
  onToggleWrap: () => void
  onCycleLevel: () => void
  onCycleService: () => void
  onSearch: () => void
  onClearSearch: () => void
  onScroll: (direction: -1 | 1, distance?: number) => void
}) {
  const compact = input.columns < 100
  const visible = selectLogWindow(input.entries, Math.max(3, input.rows - (compact ? 5 : 4)), input.offset)
  const primaryActions = <>
    <ActionButton label={input.paused ? '跟随' : '暂停'} onPress={input.onToggleFollow} active={input.paused} intent={input.paused ? 'warning' : 'healthy'} />
    <ActionButton label={`服务:${input.service}`} onPress={input.onCycleService} />
    <ActionButton label={`级别:${input.level}`} onPress={input.onCycleLevel} />
  </>
  const secondaryActions = <>
    <ActionButton label={`换行:${input.wrap ? '开' : '关'}`} onPress={input.onToggleWrap} active={input.wrap} />
    <ActionButton label="搜索" onPress={input.onSearch} />
    <ActionButton label="清除" onPress={input.onClearSearch} disabled={!input.search} subtle />
  </>
  return (
    <MouseRegion
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor={tone(consolePalette.border)}
      paddingX={1}
      priority={1}
      onWheel={direction => input.onScroll(direction)}
    >
      {compact
        ? <Box flexDirection="column"><Box gap={1}>{primaryActions}</Box><Box gap={1}>{secondaryActions}</Box></Box>
        : <Box gap={1}>{primaryActions}{secondaryActions}</Box>}
      <Text wrap="truncate-end" color={tone(consolePalette.muted)}>
        {input.paused ? 'Ⅱ 已暂停' : '▶ 实时跟随'} · {visible.label} · 搜索“{input.search || '无'}” · 滚轮/PgUp/PgDn
      </Text>
      <LogLines entries={visible.entries} wrap={input.wrap} />
    </MouseRegion>
  )
}

function LogLines({ entries, wrap }: { entries: OperationsLogEntry[]; wrap: boolean }) {
  if (!entries.length) return <Text color={tone(consolePalette.muted)}>暂无符合筛选条件的日志。</Text>
  return <>{entries.map(entry => (
    <Text key={entry.sequence} wrap={wrap ? 'wrap' : 'truncate-end'} color={tone(logColor(entry.level))}>
      {shortTime(entry.createdAt)} [{logSource(entry)}] {entry.stream === 'stderr' ? '!' : '·'} {entry.message}
    </Text>
  ))}</>
}

function logSource(entry: OperationsLogEntry): string {
  return [
    entry.serviceId ?? '监督',
    entry.component,
    entry.processId ? `PID ${entry.processId}` : null,
  ].filter(Boolean).join('/')
}

function AccountsView(input: {
  accounts: LocalManagedAccount[]
  columns: number
  selectedIndex: number
  error: string | null
  rows: number
  onSelect: (index: number) => void
  onScroll: (direction: -1 | 1) => void
  onCreate: () => void
  onAction: (action: AccountAction) => void
  onPassword: () => void
  onRefresh: () => void
}) {
  const compact = input.columns < 100
  const selected = input.accounts[input.selectedIndex] ?? null
  const isPlatformAdmin = Boolean(selected?.platformRoles.some(binding => binding.role === 'platform_admin'))
  const isDisabled = Boolean(selected?.banned || selected?.platformStatus === 'disabled')
  const visible = selectListWindow(input.accounts, input.selectedIndex, Math.max(4, input.rows - (compact ? 8 : 7)))
  return (
    <MouseRegion flexDirection="column" flexGrow={1} borderStyle="round" borderColor={tone(consolePalette.border)} paddingX={1} priority={1} onWheel={input.onScroll}>
      <Text bold color={tone(consolePalette.focus)}>Better Auth 账户 + {PRODUCT_CODENAME} RBAC 投影</Text>
      {input.error && <Text color={tone(consolePalette.danger)}>✕ {input.error}</Text>}
      <AccountActions
        compact={compact}
        selected={Boolean(selected)}
        isPlatformAdmin={isPlatformAdmin}
        isDisabled={isDisabled}
        onCreate={input.onCreate}
        onAction={input.onAction}
        onPassword={input.onPassword}
        onRefresh={input.onRefresh}
      />
      <Box>
        <Cell width={compact ? 24 : 30} muted>邮箱</Cell>
        {!compact && <Cell width={18} muted>名称</Cell>}
        <Cell width={compact ? 13 : 16} muted>认证状态</Cell>
        <Cell width={compact ? 14 : 20} muted>平台状态</Cell>
        <Cell muted>平台角色</Cell>
      </Box>
      {visible.entries.map(({ item: account, index }) => (
        <MouseRegion key={account.authUserId} width="100%" priority={10} onClick={() => input.onSelect(index)}>
          {state => <Box width="100%" backgroundColor={tone(index === input.selectedIndex ? consolePalette.selected : state.hovered ? consolePalette.panelRaised : consolePalette.canvas)}>
            <Cell width={compact ? 24 : 30} bold={index === input.selectedIndex}>{account.email}</Cell>
            {!compact && <Cell width={18}>{account.displayName}</Cell>}
            <Cell width={compact ? 13 : 16} color={account.banned ? consolePalette.danger : consolePalette.healthy}>{account.banned ? '✕ 已禁用' : '● 正常'}</Cell>
            <Cell width={compact ? 14 : 20}>{account.platformStatus ?? '未投影'}</Cell>
            <Cell>{formatAccountRoles(account)}</Cell>
          </Box>}
        </MouseRegion>
      ))}
      {!input.accounts.length && !input.error && <Text color={tone(consolePalette.muted)}>当前没有公开认证账户；Console 服务主体不会出现在此列表。</Text>}
      {selected && <Text color={tone(consolePalette.muted)}>
        选中 {selected.email} · Better Auth 角色 {selected.authRole} · {visible.label} · 滚轮/PgUp/PgDn 浏览
      </Text>}
    </MouseRegion>
  )
}

function AccountActions(input: {
  compact: boolean
  selected: boolean
  isPlatformAdmin: boolean
  isDisabled: boolean
  onCreate: () => void
  onAction: (action: AccountAction) => void
  onPassword: () => void
  onRefresh: () => void
}) {
  const primary = <>
    <ActionButton label="新建" onPress={input.onCreate} intent="healthy" />
    <ActionButton label={input.isPlatformAdmin ? '撤销管理员' : '授予管理员'} onPress={() => input.onAction(input.isPlatformAdmin ? 'revoke' : 'grant')} disabled={!input.selected} intent={input.isPlatformAdmin ? 'danger' : 'healthy'} />
    <ActionButton label={input.isDisabled ? '启用账户' : '禁用账户'} onPress={() => input.onAction(input.isDisabled ? 'enable' : 'disable')} disabled={!input.selected} intent={input.isDisabled ? 'healthy' : 'danger'} />
  </>
  const secondary = <>
    <ActionButton label="重置密码" onPress={input.onPassword} disabled={!input.selected} intent="warning" />
    <ActionButton label="撤销会话" onPress={() => input.onAction('sessions')} disabled={!input.selected} />
    <ActionButton label="刷新" onPress={input.onRefresh} subtle />
  </>
  return input.compact
    ? <Box flexDirection="column"><Box gap={1}>{primary}</Box><Box gap={1}>{secondary}</Box></Box>
    : <Box gap={1}>{primary}{secondary}</Box>
}

function AuditView(input: {
  audits: AuditEvent[]
  columns: number
  selectedIndex: number
  error: string | null
  rows: number
  onSelect: (index: number) => void
  onScroll: (direction: -1 | 1) => void
  onRefresh: () => void
}) {
  const compact = input.columns < 100
  const selected = input.audits[input.selectedIndex] ?? null
  const visible = selectListWindow(input.audits, input.selectedIndex, Math.max(4, input.rows - 6))
  return (
    <MouseRegion flexDirection="column" flexGrow={1} borderStyle="round" borderColor={tone(consolePalette.border)} paddingX={1} priority={1} onWheel={input.onScroll}>
      <Box justifyContent="space-between">
        <Text bold color={tone(consolePalette.focus)}>本机运维与平台审计</Text>
        <ActionButton label="刷新" onPress={input.onRefresh} subtle />
      </Box>
      {input.error && <Text color={tone(consolePalette.danger)}>✕ {input.error}</Text>}
      <Box><Cell width={compact ? 17 : 20} muted>时间</Cell><Cell width={compact ? 29 : 38} muted>动作</Cell><Cell width={compact ? 10 : 12} muted>结果</Cell><Cell muted>对象</Cell></Box>
      {visible.entries.map(({ item: event, index }) => (
        <MouseRegion key={event.auditEventId} width="100%" priority={10} onClick={() => input.onSelect(index)}>
          {state => <Box width="100%" backgroundColor={tone(index === input.selectedIndex ? consolePalette.selected : state.hovered ? consolePalette.panelRaised : consolePalette.canvas)}>
            <Cell width={compact ? 17 : 20}>{shortDate(event.createdAt)}</Cell>
            <Cell width={compact ? 29 : 38} bold={index === input.selectedIndex}>{event.action}</Cell>
            <Cell width={compact ? 10 : 12} color={event.outcome === 'allowed' ? consolePalette.healthy : event.outcome === 'denied' ? consolePalette.warning : consolePalette.danger}>{event.outcome}</Cell>
            <Cell>{event.objectType} {event.objectId ?? ''}</Cell>
          </Box>}
        </MouseRegion>
      ))}
      {!input.audits.length && !input.error && <Text color={tone(consolePalette.muted)}>暂无审计事件。</Text>}
      {selected && <Text color={tone(consolePalette.muted)}>
        选中 {selected.action} · {selected.outcome} · {visible.label} · 滚轮/PgUp/PgDn 浏览
      </Text>}
    </MouseRegion>
  )
}

function DialogView(input: {
  dialog: ConsoleDialog
  minPasswordLength: number
  onCancel: () => void
  onSearch: (value: string) => void
  onCreateSubmit: (value: string) => void
  onPasswordSubmit: (value: string) => void
}) {
  useInput((value, key) => {
    if (key.escape || (key.ctrl && value === 'c')) input.onCancel()
  })
  const dialog = input.dialog
  return (
    <Box flexGrow={1} justifyContent="center" alignItems="center">
      <Box width={72} minHeight={10} flexDirection="column" borderStyle="double" borderColor={tone(consolePalette.focus)} paddingX={2} paddingY={1} backgroundColor={tone(consolePalette.panelRaised)}>
        {dialog.kind === 'help' && <HelpContent />}
        {dialog.kind === 'search' && <>
          <Text bold color={tone(consolePalette.focus)}>日志搜索</Text>
          <Text color={tone(consolePalette.muted)}>输入关键字；支持中文与粘贴。空值清除筛选。</Text>
          <PasteTextInput placeholder="关键字" onSubmit={input.onSearch} />
          <Box gap={1}><ActionButton label="清除筛选" onPress={() => input.onSearch('')} /><ActionButton label="取消" onPress={input.onCancel} subtle /></Box>
        </>}
        {dialog.kind === 'confirm' && <>
          <Text bold color={tone(dialog.expected ? consolePalette.danger : consolePalette.warning)}>{dialog.title}</Text>
          <Text>{dialog.detail}</Text>
          {dialog.expected
            ? <>
                <Text color={tone(consolePalette.muted)}>请输入“{dialog.expected}”确认：</Text>
                <PasteTextInput onSubmit={value => {
                  if (value.trim() === dialog.expected) void dialog.execute()
                  else input.onCancel()
                }} />
              </>
            : <>
                <ConfirmInput defaultChoice="cancel" onConfirm={() => void dialog.execute()} onCancel={input.onCancel} />
                <Box gap={1}>
                  <ActionButton label="确认执行" onPress={() => void dialog.execute()} intent="warning" />
                  <ActionButton label="取消" onPress={input.onCancel} subtle />
                </Box>
              </>}
        </>}
        {dialog.kind === 'create' && <>
          <Text bold color={tone(consolePalette.focus)}>创建平台管理员 · 本机根权限</Text>
          <Text color={tone(consolePalette.muted)}>步骤 {createStepNumber(dialog.step)}/5 · 认证写入使用 Better Auth Admin API。</Text>
          {dialog.step === 'email' && <PasteTextInput key="create-email" placeholder="邮箱" onSubmit={input.onCreateSubmit} />}
          {dialog.step === 'name' && <PasteTextInput key="create-name" placeholder="显示名称" onSubmit={input.onCreateSubmit} />}
          {dialog.step === 'password' && <><Text>密码至少 {input.minPasswordLength} 个字符：</Text><PasswordInput onSubmit={input.onCreateSubmit} /></>}
          {dialog.step === 'repeat' && <><Text>再次输入密码：</Text><PasswordInput onSubmit={input.onCreateSubmit} /></>}
          {dialog.step === 'confirm' && <><Text color={tone(consolePalette.danger)}>输入目标邮箱“{dialog.email}”确认创建：</Text><PasteTextInput key="create-confirm" onSubmit={input.onCreateSubmit} /></>}
        </>}
        {dialog.kind === 'password' && <>
          <Text bold color={tone(consolePalette.danger)}>重置密码并撤销全部会话</Text>
          <Text color={tone(consolePalette.muted)}>目标：{dialog.targetEmail} · 步骤 {dialog.step === 'password' ? 1 : dialog.step === 'repeat' ? 2 : 3}/3</Text>
          {dialog.step === 'password' && <><Text>新密码至少 {input.minPasswordLength} 个字符：</Text><PasswordInput onSubmit={input.onPasswordSubmit} /></>}
          {dialog.step === 'repeat' && <><Text>再次输入新密码：</Text><PasswordInput onSubmit={input.onPasswordSubmit} /></>}
          {dialog.step === 'confirm' && <><Text>输入目标邮箱确认：</Text><PasteTextInput key="password-confirm" onSubmit={input.onPasswordSubmit} /></>}
        </>}
        <Box justifyContent="space-between">
          <Text color={tone(consolePalette.muted)}>Esc 取消 · 鼠标可选择按钮</Text>
          <ActionButton label={dialog.kind === 'help' ? '关闭' : '取消'} onPress={input.onCancel} subtle />
        </Box>
      </Box>
    </Box>
  )
}

function PasteTextInput(input: { placeholder?: string; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('')
  const [revision, setRevision] = useState(0)
  usePaste(text => {
    setValue(current => `${current}${text.replace(/[\r\n]+/gu, ' ')}`.slice(0, 500))
    setRevision(current => current + 1)
  })
  return <TextInput
    key={revision}
    defaultValue={value}
    {...(input.placeholder === undefined ? {} : { placeholder: input.placeholder })}
    onChange={setValue}
    onSubmit={input.onSubmit}
  />
}

function HelpContent() {
  return <>
    <Text bold color={tone(consolePalette.focus)}>键盘与鼠标</Text>
    <Text>1–4 / Tab 切换页面 · ↑↓ 选择 · Enter 检查器</Text>
    <Text>S 启动 · X 停止 · R 重启 · / 搜索日志</Text>
    <Text>F 暂停/跟随 · W 换行 · L 级别 · [ ] 服务 · Home/End/PgUp/PgDn</Text>
    <Text>账户：N 新建 · G 授权 · X 撤权 · E 启停 · P 密码 · V 会话</Text>
    <Text color={tone(consolePalette.focus)}>鼠标：单击标签、行和操作按钮；滚轮浏览日志、账户与审计。</Text>
    <Text color={tone(consolePalette.healthy)}>q / Ctrl+C：仅分离，服务继续运行</Text>
    <Text color={tone(consolePalette.danger)}>Q：输入“停止全部”后停止服务并关闭监督器</Text>
  </>
}

function SizeWarning({ columns, rows, onExit }: { columns: number; rows: number; onExit: () => void }) {
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) onExit()
  })
  return (
    <Box width={Math.max(1, columns)} height={Math.max(1, rows)} justifyContent="center" alignItems="center" flexDirection="column">
      <Text bold color={tone(consolePalette.warning)}>终端尺寸不足，界面已安全暂停渲染。</Text>
      <Text>当前 {columns}×{rows}，至少需要 80×24。</Text>
      <Text color={tone(consolePalette.muted)}>请放大窗口；q / Ctrl+C 仅分离。</Text>
      <ActionButton label="分离运维台" onPress={onExit} />
    </Box>
  )
}

function ConsoleFooter({ tab, feedback, mouseEnabled, columns, onDetach, onShutdown }: {
  tab: LocalConsoleTab
  feedback: string
  mouseEnabled: boolean
  columns: number
  onDetach: () => void
  onShutdown: () => void
}) {
  const compact = columns < 100
  const keys = tab === 'services'
    ? compact ? '↑↓ 选择 · Enter 详情 · S/X/R 启停重启 · / 搜索' : '↑↓ 选择  Enter 检查器  S 启动  X 停止  R 重启  / 搜索'
    : tab === 'logs'
      ? compact ? 'F 跟随 · W 换行 · L 级别 · [ ] 服务 · / 搜索' : 'F 暂停/跟随  W 换行  L 级别  [ ] 服务  / 搜索'
      : tab === 'accounts'
        ? compact ? '↑↓ 选择 · N 新建 · G/X 权限 · E 启停 · P 密码 · U 刷新' : '↑↓ 选择  N 新建  G 授权  X 撤权  E 启停  P 密码  V 会话  U 刷新'
        : '↑↓ 选择  U 刷新'
  return (
    <Box flexShrink={0} borderStyle="single" borderColor={tone(consolePalette.border)} paddingX={1} flexDirection="column">
      <Text wrap="truncate-end" color={tone(consolePalette.text)}>{keys}</Text>
      <Box width="100%">
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end" color={tone(consolePalette.muted)}>{feedback} · 鼠标{mouseEnabled ? '可用' : '不可用'}</Text>
        </Box>
        <Box gap={1} flexShrink={0}>
          <ActionButton label="分离" onPress={onDetach} subtle />
          <ActionButton label={compact ? '全停' : '停止全部'} onPress={onShutdown} intent="danger" subtle />
        </Box>
      </Box>
    </Box>
  )
}

function ActionButton(input: {
  label: string
  onPress: () => void
  disabled?: boolean
  active?: boolean
  subtle?: boolean
  intent?: 'default' | 'healthy' | 'warning' | 'danger'
}) {
  const disabled = Boolean(input.disabled)
  const intentColor = input.intent === 'healthy'
    ? consolePalette.healthy
    : input.intent === 'warning'
      ? consolePalette.warning
      : input.intent === 'danger'
        ? consolePalette.danger
        : consolePalette.focus
  return (
    <MouseRegion
      priority={30}
      disabled={disabled}
      aria-role="button"
      aria-label={input.label}
      aria-state={{ disabled, selected: Boolean(input.active) }}
      onClick={input.onPress}
    >
      {(state: MouseRegionState) => {
        const background = state.pressed
          ? intentColor
          : state.hovered || input.active
            ? consolePalette.selected
            : input.subtle
              ? consolePalette.canvas
              : consolePalette.panel
        const color = disabled
          ? consolePalette.muted
          : state.pressed
            ? consolePalette.canvas
            : input.active || state.hovered
              ? intentColor
              : input.subtle
                ? consolePalette.muted
                : consolePalette.text
        const marker = disabled ? '×' : state.pressed ? '◆' : input.active ? '●' : state.hovered ? '›' : '·'
        return <Text bold={Boolean(state.hovered || input.active)} color={tone(color)} backgroundColor={tone(background)}>
          {' '}{marker} {input.label}{' '}
        </Text>
      }}
    </MouseRegion>
  )
}

function Cell(input: { width?: number; children: React.ReactNode; muted?: boolean; bold?: boolean; color?: string }) {
  return <Box width={input.width} flexShrink={input.width ? 0 : 1} paddingRight={1}>
    <Text wrap="truncate-end" bold={Boolean(input.bold)} color={tone(input.color ?? (input.muted ? consolePalette.muted : consolePalette.text))}>{input.children}</Text>
  </Box>
}

function servicePresentation(service: OperationsServiceSnapshot): { symbol: string; label: string; color: string } {
  const map: Record<OperationsServiceSnapshot['state'], { symbol: string; label: string; color: string }> = {
    stopped: { symbol: '○', label: '已停止', color: consolePalette.muted },
    waiting_dependency: { symbol: '◌', label: '等待依赖', color: consolePalette.warning },
    starting: { symbol: '◐', label: '启动中', color: consolePalette.focus },
    healthy: { symbol: '●', label: '健康', color: consolePalette.healthy },
    degraded: { symbol: '▲', label: '降级', color: consolePalette.warning },
    stopping: { symbol: '◑', label: '停止中', color: consolePalette.warning },
    restart_wait: { symbol: '↻', label: '等待重启', color: consolePalette.warning },
    failed: { symbol: '✕', label: '失败', color: consolePalette.danger },
    conflict: { symbol: '◆', label: '冲突', color: consolePalette.danger },
  }
  return map[service.state]
}

function serviceImpact(service: OperationsServiceSnapshot, snapshot: OperationsSnapshot | null): string {
  if (service.serviceId === 'infra') return '基础设施停止会中断数据库、地图瓦片和所有上层服务。'
  const blocked = snapshot?.services.filter(item => item.blockedBy.includes(service.serviceId)).map(item => item.displayName) ?? []
  return blocked.length ? `依赖影响：${blocked.join('、')} 将进入降级或停止。` : '操作只针对当前服务及其运行中的依赖方。'
}

function assertOperationSucceeded(result: OperationsOperationResult): void {
  if (result.outcome === 'failed') throw new Error(result.message)
}

function operationFeedback(result: OperationsOperationResult): string {
  return `${result.outcome === 'succeeded' ? '✓' : result.outcome === 'partial' ? '▲' : '✕'} ${result.message} · ${result.operationId.slice(0, 8)}`
}

function cycleService(current: OperationsServiceId | 'all', direction: number): OperationsServiceId | 'all' {
  const values: Array<OperationsServiceId | 'all'> = ['all', ...ALL_SERVICES]
  const index = values.indexOf(current)
  return values[(index + direction + values.length) % values.length] ?? 'all'
}

function formatAccountRoles(account: LocalManagedAccount): string {
  const roles = [...new Set(account.platformRoles.map(binding => binding.role))]
  return roles.length ? roles.join(', ') : '无'
}

function logColor(level: OperationsLogEntry['level']): string {
  if (level === 'error') return consolePalette.danger
  if (level === 'warn') return consolePalette.warning
  if (level === 'debug') return consolePalette.muted
  if (level === 'info') return consolePalette.text
  return consolePalette.muted
}

function formatMetric(value: number | null, suffix: string): string {
  return value === null ? '未知' : `${value.toFixed(1)}${suffix}`
}

function metricDetail(metric: { value: number | null; unavailableReason?: string | undefined }, suffix: string): string {
  return metric.value === null ? `未知${metric.unavailableReason ? `（${metric.unavailableReason}）` : ''}` : formatMetric(metric.value, suffix)
}

function metricBytesDetail(metric: { value: number | null; unavailableReason?: string | undefined }): string {
  return metric.value === null ? `未知${metric.unavailableReason ? `（${metric.unavailableReason}）` : ''}` : formatBytes(metric.value)
}

function formatBytes(value: number | null): string {
  if (value === null) return '未知'
  if (value < 1024) return `${value.toFixed(0)} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(1)} GiB`
}

function formatPercent(used: number | null, total: number | null): string {
  if (used === null || total === null || total <= 0) return '未知'
  return `${((used / total) * 100).toFixed(1)}%`
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function shortTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString('zh-CN', { hour12: false })
}

function shortDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false }).slice(0, 19)
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)))
}

function selectLogWindow(entries: OperationsLogEntry[], capacity: number, offset: number): {
  entries: OperationsLogEntry[]
  label: string
} {
  const safeCapacity = Math.max(1, capacity)
  const safeOffset = Math.max(0, Math.min(offset, Math.max(0, entries.length - safeCapacity)))
  const end = Math.max(0, entries.length - safeOffset)
  const start = Math.max(0, end - safeCapacity)
  return {
    entries: entries.slice(start, end),
    label: entries.length ? `${start + 1}–${end}/${entries.length}` : '0/0',
  }
}

function calculateLogCapacity(
  tab: LocalConsoleTab,
  columns: number,
  rows: number,
  inspectorRequested: boolean,
): number {
  if (tab !== 'services') return Math.max(3, rows - 15)
  const inspectorVisible = columns >= 140 || inspectorRequested
  const servicePanelRows = inspectorVisible ? 14 : 9
  const margin = rows >= 26 ? 1 : 0
  return Math.max(1, rows - 14 - servicePanelRows - margin)
}

function selectListWindow<T>(items: T[], selectedIndex: number, capacity: number): {
  entries: Array<{ item: T; index: number }>
  label: string
} {
  const safeCapacity = Math.max(1, capacity)
  const selected = clampIndex(selectedIndex, items.length)
  const start = Math.max(0, Math.min(
    selected - Math.floor(safeCapacity / 2),
    Math.max(0, items.length - safeCapacity),
  ))
  const end = Math.min(items.length, start + safeCapacity)
  return {
    entries: items.slice(start, end).map((item, index) => ({ item, index: start + index })),
    label: items.length ? `${start + 1}–${end}/${items.length}` : '0/0',
  }
}

function createStepNumber(step: Extract<ConsoleDialog, { kind: 'create' }>['step']): number {
  return { email: 1, name: 2, password: 3, repeat: 4, confirm: 5 }[step]
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500) : '未知错误。'
}

function tone(color: string): string {
  return color
}

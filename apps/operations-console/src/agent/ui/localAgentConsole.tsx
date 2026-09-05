// +-------------------------------------------------------------------------
//
//   地理智能平台 - 中文本机 Agent 终端
//
//   文件:       localAgentConsole.tsx
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-07-27):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 增加分层品牌色、状态徽标和仅在活动期间运行的思考动画。
// --------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentThreadRecord, DecisionRequest } from '@geo-agent-platform/shared-types'
import { PRODUCT_CODENAME_UPPER } from '@geo-agent-platform/shared-types/product-identity'
import { ThemeProvider } from '@inkjs/ui'
import { Box, Text, render, useApp, useInput, usePaste, useWindowSize } from 'ink'

import { LocalConsoleMouseProvider, MouseRegion } from '../../localConsoleMouse.js'
import { consolePalette, platformConsoleTheme } from '../../localConsoleTheme.js'
import {
  type LocalAgentSession,
  type LocalAgentSessionSnapshot,
} from '../application/localAgentSession.js'
import {
  AgentActivityIndicator,
  describeAgentActivity,
  terminalMotionEnabled,
} from './localAgentActivity.js'
import {
  runPresentation,
  type AgentDisplayLine,
  type AgentLineTone,
} from './localAgentView.js'
import {
  createTerminalMouseController,
  type TerminalMouseSource,
} from '../../terminalMouse.js'
import {
  localAgentSlashCommands,
  parseLocalAgentSlashCommand,
  suggestLocalAgentSlashCommands,
  type LocalAgentSlashCommandDefinition,
} from './localAgentCommandRegistry.js'
import {
  agentInputGraphemes,
  agentInputLength,
  agentInputViewport,
  insertAgentInput,
  moveAgentInputHorizontal,
  moveAgentInputToLineBoundary,
  moveAgentInputVertical,
  navigateAgentInputHistory,
  normalizeAgentPaste,
  removeAgentInputAt,
  removeAgentInputBefore,
  type AgentInputEdit,
  type AgentInputHistoryState,
  type AgentInputViewport,
} from './localAgentEditor.js'
import {
  FOLLOW_AGENT_TIMELINE,
  revealAgentTimelineLine,
  resolveAgentTimelineWindow,
  scrollAgentTimeline,
  type AgentTimelineScroll,
} from './localAgentScroll.js'
import { LocalAgentTimelineProjection } from './localAgentTimeline.js'

const MIN_COLUMNS = 60
const MIN_ROWS = 16
const MAX_INPUT_LENGTH = 16_000
const MAX_VISIBLE_DECISION_OPTIONS = 4
const MAX_VISIBLE_SLASH_COMMANDS = 7

export interface LocalAgentConsoleIdentity {
  version: string
  projectRoot: string
  osUser: string
  hostname: string
  keyVersion: string
}

export type LocalAgentConsoleSession = Pick<
  LocalAgentSession,
  | 'snapshot'
  | 'subscribe'
  | 'close'
  | 'submit'
  | 'respondDecision'
  | 'cancel'
  | 'resume'
  | 'setExecutionMode'
  | 'setReasoning'
  | 'newConversation'
  | 'listThreads'
  | 'openThread'
>

export async function runLocalAgentConsole(
  session: LocalAgentConsoleSession,
  identity: LocalAgentConsoleIdentity,
): Promise<void> {
  const mouse = createTerminalMouseController(process.stdin, process.stdout, { trackMotion: false })
  const instance = render(
    <ThemeProvider theme={platformConsoleTheme}>
      <LocalAgentConsoleApp
        session={session}
        identity={identity}
        mouse={mouse}
        animationsEnabled={terminalMotionEnabled(process.env)}
      />
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

export function LocalAgentConsoleApp({
  session,
  identity,
  mouse,
  animationsEnabled = false,
}: {
  session: LocalAgentConsoleSession
  identity: LocalAgentConsoleIdentity
  mouse?: TerminalMouseSource
  animationsEnabled?: boolean
}) {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [snapshot, setSnapshot] = useState(() => session.snapshot())
  const [timeline] = useState(() => new LocalAgentTimelineProjection(
    snapshot.items,
    snapshot.bootstrap?.tools ?? [],
  ))
  const [editor, setEditor] = useState<AgentInputEdit>({ value: '', cursorIndex: 0 })
  const input = editor.value
  const [history, setHistory] = useState<string[]>([])
  const [historyState, setHistoryState] = useState<AgentInputHistoryState>({ index: null, draft: '' })
  const [scroll, setScroll] = useState<AgentTimelineScroll>(FOLLOW_AGENT_TIMELINE)
  const [feedback, setFeedback] = useState('就绪。输入自然语言问题，Enter 发送。')
  const [busy, setBusy] = useState(false)
  const [help, setHelp] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [threadIndex, setThreadIndex] = useState(0)
  const [decisionIndex, setDecisionIndex] = useState(0)
  const decisionIndexRef = useRef(0)
  const [slashCommandIndex, setSlashCommandIndex] = useState(0)
  const slashCommandIndexRef = useRef(0)
  const [approvalArmed, setApprovalArmed] = useState(false)
  const [expandedToolIds, setExpandedToolIds] = useState<ReadonlySet<string>>(() => new Set())
  const [focusedToolId, setFocusedToolId] = useState<string | null>(null)
  const decisionIdRef = useRef<string | null>(null)
  const lastInterruptRef = useRef(0)
  const inFlightRef = useRef(false)

  useEffect(() => session.subscribe(next => {
    timeline.replaceItems(next.items, next.bootstrap?.tools ?? [])
    setSnapshot(next)
  }), [session, timeline])

  const decision = useMemo(() => pendingDecision(snapshot), [snapshot])
  useEffect(() => {
    if (decision?.decisionId === decisionIdRef.current) return
    decisionIdRef.current = decision?.decisionId ?? null
    setApprovalArmed(false)
    const rejectIndex = decision?.kind === 'approval'
      ? decision.options.findIndex(option => option.payload.approved === false)
      : 0
    const nextIndex = rejectIndex >= 0 ? rejectIndex : 0
    decisionIndexRef.current = nextIndex
    setDecisionIndex(nextIndex)
  }, [decision])

  const slashCommandSuggestions = useMemo(
    () => decision || busy || historyOpen || statusOpen ? [] : suggestLocalAgentSlashCommands(input),
    [busy, decision, historyOpen, input, statusOpen],
  )
  const slashCommandMenuOpen = slashCommandSuggestions.length > 0
  useEffect(() => {
    slashCommandIndexRef.current = 0
    setSlashCommandIndex(0)
  }, [input])

  const dense = columns < 80 || rows < 24
  const compact = columns < 100
  const wide = !dense && columns >= 140 && rows >= 32
  const editorWidth = Math.max(8, columns - 6)
  const editorViewport = agentInputViewport(editor, editorWidth, dense ? 1 : 4)
  const composerHeight = dense ? 3 : Math.min(7, editorViewport.visibleRows + 3)
  const decisionRows = decision
    ? (dense ? 4 : 4 + Math.min(MAX_VISIBLE_DECISION_OPTIONS, decision.options.length))
    : 0
  const slashCommandRows = slashCommandMenuOpen
    ? Math.min(slashCommandSuggestions.length, dense ? 3 : MAX_VISIBLE_SLASH_COMMANDS) + 2
    : 0
  const chromeRows = dense ? 9 : 12
  const contentRows = Math.max(1, rows - chromeRows - composerHeight - decisionRows - slashCommandRows)
  const conversationWidth = wide ? columns - 46 : columns - 4
  const allLines = timeline.getLines(conversationWidth - 2, expandedToolIds)
  const timelineWindow = resolveAgentTimelineWindow(allLines, contentRows, scroll)
  const toolIds = timeline.getToolIds()
  const normalizedHistoryQuery = historyQuery.trim().toLocaleLowerCase('zh-CN')
  const visibleThreads = useMemo(() => {
    const threads = snapshot.bootstrap?.threads ?? []
    if (!normalizedHistoryQuery) return threads
    return threads.filter(thread => [
      thread.title,
      thread.latestUserQuery,
      thread.latestAssistantSummary,
      thread.historyPreview,
    ].some(candidate => candidate?.toLocaleLowerCase('zh-CN').includes(normalizedHistoryQuery)))
  }, [normalizedHistoryQuery, snapshot.bootstrap?.threads])

  useEffect(() => {
    if (!toolIds.length) {
      setFocusedToolId(null)
      return
    }
    if (focusedToolId && !toolIds.includes(focusedToolId)) setFocusedToolId(null)
  }, [focusedToolId, toolIds.join('\u0000')])

  useEffect(() => {
    setThreadIndex(index => Math.max(0, Math.min(index, Math.max(0, visibleThreads.length - 1))))
  }, [visibleThreads.length])

  const disconnect = useCallback(() => {
    session.close()
    exit()
  }, [exit, session])

  const beginNewConversation = useCallback(() => {
    try {
      session.newConversation()
      setScroll(FOLLOW_AGENT_TIMELINE)
      setFocusedToolId(null)
      setFeedback('已开始新的本地 Agent 对话。')
    } catch (error) {
      setFeedback(formatUiError(error))
    }
  }, [session])

  const runAction = useCallback(async (action: () => Promise<void>): Promise<void> => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    try {
      await action()
    } catch (error) {
      setFeedback(formatUiError(error))
    } finally {
      inFlightRef.current = false
      setBusy(false)
    }
  }, [])

  const showHistory = useCallback(() => {
    setHelp(false)
    setStatusOpen(false)
    setHistoryOpen(true)
    setHistoryQuery('')
    setThreadIndex(0)
    void runAction(async () => {
      await session.listThreads()
      setFeedback('已刷新最近对话。')
    })
  }, [runAction, session])

  const showStatus = useCallback(() => {
    setHelp(false)
    setHistoryOpen(false)
    setStatusOpen(true)
    setFeedback('状态面板已打开。')
  }, [])

  const submitDecision = useCallback((selected: DecisionRequest['options'][number] | null, text?: string) => {
    if (!decision) return
    if (decision.kind === 'approval' && selected?.payload.approved === true && !approvalArmed) {
      setApprovalArmed(true)
      setFeedback('批准可能执行写入或受保护工具；再次按 Enter 或再次单击“批准”确认。')
      return
    }
    void runAction(async () => {
      await session.respondDecision({
        decisionId: decision.decisionId,
        ...(selected?.optionId ? { optionId: selected.optionId } : {}),
        ...(text?.trim() ? { text: text.trim() } : {}),
      })
      setEditor({ value: '', cursorIndex: 0 })
      setHistoryState({ index: null, draft: '' })
      setApprovalArmed(false)
      setFeedback(decision.kind === 'approval' ? '审批决定已提交，正在恢复原运行。' : '补充信息已提交。')
      setScroll(FOLLOW_AGENT_TIMELINE)
    })
  }, [approvalArmed, decision, runAction, session])

  const executeCommand = useCallback((value: string): boolean => {
    const parsed = parseLocalAgentSlashCommand(value)
    if (!parsed) return false
    if (!parsed.definition) {
      setFeedback(`未知命令 ${parsed.rawCommand}；输入 / 查看可用命令。`)
      return true
    }
    parsed.definition.execute({
      snapshot,
      session,
      setFeedback,
      showHelp: () => setHelp(true),
      showHistory,
      showStatus,
      disconnect,
      beginNewConversation,
      runAction,
    }, parsed.argument)
    return true
  }, [beginNewConversation, disconnect, runAction, session, showHistory, showStatus, snapshot])

  const completeSlashCommand = useCallback((command: LocalAgentSlashCommandDefinition) => {
    const completed = `${command.command}${command.expectsArgument ? ' ' : ''}`
    setEditor({ value: completed, cursorIndex: agentInputLength(completed) })
    setHistoryState({ index: null, draft: '' })
    setFeedback(command.expectsArgument
      ? `${command.usage}：请补充参数后按 Enter 执行。`
      : `${command.command} 已补全；按 Enter 执行。`)
  }, [])

  const submitInput = useCallback(() => {
    const value = input.trim()
    if (decision?.kind === 'clarification' && value && !value.startsWith('/')) {
      submitDecision(null, value)
      return
    }
    if (value && executeCommand(value)) {
      setEditor({ value: '', cursorIndex: 0 })
      setHistoryState({ index: null, draft: '' })
      return
    }
    if (decision) {
      const selected = decision.options[decisionIndexRef.current] ?? null
      if (!value && selected) submitDecision(selected)
      else setFeedback(decision.kind === 'approval'
        ? '审批必须使用 ↑↓ 选择“批准”或“拒绝”。'
        : '请选择一个选项，或直接输入补充信息。')
      return
    }
    if (!value) return
    setHistory(current => [...current.filter(item => item !== value), value].slice(-100))
    setHistoryState({ index: null, draft: '' })
    setEditor({ value: '', cursorIndex: 0 })
    setScroll(FOLLOW_AGENT_TIMELINE)
    void runAction(async () => {
      const previousRun = snapshot.run
      await session.submit(value)
      setFeedback(previousRun && ['queued', 'running'].includes(previousRun.status)
        ? '引导消息已排队，不会重放当前运行。'
        : '问题已提交。')
    })
  }, [decision, executeCommand, input, runAction, session, snapshot.run, submitDecision])

  usePaste(text => {
    if (help) return
    const insertion = normalizeAgentPaste(text)
    if (historyOpen) {
      setHistoryQuery(current => `${current}${insertion.replace(/\s+/gu, ' ')}`.slice(0, 200))
      setThreadIndex(0)
      return
    }
    setEditor(current => insertAgentInput(current, insertion, MAX_INPUT_LENGTH))
    setHistoryState({ index: null, draft: '' })
  }, { isActive: columns >= MIN_COLUMNS && rows >= MIN_ROWS })

  useInput((value, key) => {
    if (help) {
      if (key.escape || key.return || value === '?' || value === '\u001bOP') setHelp(false)
      if (!(key.ctrl && (value === 'c' || value === 'd'))) return
    }
    if (statusOpen) {
      if (key.escape || key.return || value === '?' || value === '\u001bOP') {
        setStatusOpen(false)
        setFeedback('已关闭状态面板。')
        return
      }
      if (!(key.ctrl && (value === 'c' || value === 'd'))) return
    }
    if (historyOpen) {
      if (key.ctrl && value === 'd') {
        disconnect()
        return
      }
      if (key.ctrl && value === 'c' && snapshot.run && ['queued', 'running'].includes(snapshot.run.status)) {
        void session.cancel()
          .then(() => setFeedback('运行已取消；服务与监督器保持运行。'))
          .catch(error => setFeedback(formatUiError(error)))
        return
      }
      if (key.ctrl && value === 'c' && busy) {
        const now = Date.now()
        if (now - lastInterruptRef.current < 2_000) disconnect()
        else {
          lastInterruptRef.current = now
          setFeedback('历史列表仍在刷新；再次按 Ctrl+C 可立即分离。')
        }
        return
      }
      if (key.escape || (key.ctrl && value === 'c')) {
        setHistoryOpen(false)
        setFeedback('已关闭最近对话；当前对话没有变化。')
        return
      }
      if (key.upArrow || key.downArrow) {
        const maximum = Math.max(0, visibleThreads.length - 1)
        setThreadIndex(index => Math.max(0, Math.min(maximum, index + (key.downArrow ? 1 : -1))))
        return
      }
      if (key.backspace) {
        const graphemes = agentInputGraphemes(historyQuery)
        graphemes.pop()
        setHistoryQuery(graphemes.join(''))
        setThreadIndex(0)
        return
      }
      if (key.return) {
        if (busy) {
          setFeedback('历史列表仍在刷新，请稍候；当前选择已保留。')
          return
        }
        const selected = visibleThreads[threadIndex]
        if (!selected) {
          setFeedback('没有可打开的对话。')
          return
        }
        void runAction(async () => {
          await session.openThread(selected.id)
          setHistoryOpen(false)
          setScroll(FOLLOW_AGENT_TIMELINE)
          setFocusedToolId(null)
          setFeedback(`已打开对话：${selected.title}`)
        })
        return
      }
      if (!key.ctrl && !key.meta && !key.tab && value && !/^\u001b/u.test(value)) {
        setHistoryQuery(current => `${current}${value}`.slice(0, 200))
        setThreadIndex(0)
      }
      return
    }
    if (key.ctrl && value === 'c') {
      if (snapshot.run && ['queued', 'running'].includes(snapshot.run.status)) {
        void session.cancel()
          .then(() => setFeedback('运行已取消；服务与监督器保持运行。'))
          .catch(error => setFeedback(formatUiError(error)))
        return
      }
      if (busy) {
        const now = Date.now()
        if (now - lastInterruptRef.current < 2_000) disconnect()
        else {
          lastInterruptRef.current = now
          setFeedback('操作仍在等待响应；再次按 Ctrl+C 可立即分离，未确认写入不会重放。')
        }
        return
      }
      if (input) {
        setEditor({ value: '', cursorIndex: 0 })
        setHistoryState({ index: null, draft: '' })
        setFeedback('输入已清空。')
        return
      }
      const now = Date.now()
      if (now - lastInterruptRef.current < 2_000) disconnect()
      else {
        lastInterruptRef.current = now
        setFeedback('再次按 Ctrl+C 分离 Agent；后台服务不会停止。')
      }
      return
    }
    if (key.ctrl && value === 'd' && !input) {
      disconnect()
      return
    }
    if (busy && key.escape) {
      setFeedback('操作仍在等待响应；可以继续编辑下一条输入，未确认的写操作不会自动重放。')
      return
    }
    if (value === '\u001bOP' || (!input && value === '?')) {
      setHistoryOpen(false)
      setStatusOpen(false)
      setHelp(true)
      return
    }
    if (key.escape) {
      if (slashCommandMenuOpen) {
        setEditor({ value: '', cursorIndex: 0 })
        setFeedback('已关闭斜杠命令提示。')
        return
      }
      setApprovalArmed(false)
      setFeedback('已取消当前界面选择；没有执行任何操作。')
      return
    }
    if (slashCommandMenuOpen && (key.upArrow || key.downArrow)) {
      const length = slashCommandSuggestions.length
      const nextIndex = (
        slashCommandIndexRef.current
        + (key.downArrow ? 1 : -1)
        + length
      ) % length
      slashCommandIndexRef.current = nextIndex
      setSlashCommandIndex(nextIndex)
      return
    }
    if (decision && (key.upArrow || key.downArrow)) {
      const length = Math.max(1, decision.options.length)
      const nextIndex = (
        decisionIndexRef.current
        + (key.downArrow ? 1 : -1)
        + length
      ) % length
      decisionIndexRef.current = nextIndex
      setDecisionIndex(nextIndex)
      setApprovalArmed(false)
      return
    }
    if (!decision && (key.upArrow || key.downArrow)) {
      const direction = key.upArrow ? -1 : 1
      const vertical = historyState.index === null
        ? moveAgentInputVertical(editor, direction, editorWidth)
        : null
      if (vertical) {
        setEditor(vertical)
        return
      }
      const next = navigateAgentInputHistory({ edit: editor, history, state: historyState, direction })
      setEditor(next.edit)
      setHistoryState(next.state)
      return
    }
    if (key.pageUp || key.pageDown) {
      setScroll(current => scrollAgentTimeline(
        allLines,
        contentRows,
        current,
        key.pageUp ? -Math.max(3, contentRows - 1) : Math.max(3, contentRows - 1),
      ))
      return
    }
    if (key.ctrl && value === 'j') {
      setEditor(current => insertAgentInput(current, '\n', MAX_INPUT_LENGTH))
      setHistoryState({ index: null, draft: '' })
      return
    }
    if (key.tab) {
      if (slashCommandMenuOpen) {
        const selected = slashCommandSuggestions[slashCommandIndexRef.current]
        if (selected) completeSlashCommand(selected)
        return
      }
      if (!decision && !input && toolIds.length) {
        const selectedIndex = focusedToolId ? toolIds.indexOf(focusedToolId) : -1
        const increment = key.shift ? -1 : 1
        const nextIndex = selectedIndex < 0
          ? (key.shift ? 0 : toolIds.length - 1)
          : (selectedIndex + increment + toolIds.length) % toolIds.length
        const nextToolId = toolIds[nextIndex] ?? null
        setFocusedToolId(nextToolId)
        if (nextToolId) {
          const target = allLines.find(line => line.toolHeader && line.toolId === nextToolId)
          if (target) {
            setScroll(current => revealAgentTimelineLine(
              allLines,
              contentRows,
              current,
              target.key,
            ))
          }
          setFeedback('已选择工具记录；按 Enter 展开或收起详情。')
        }
      }
      return
    }
    if (key.return) {
      if (busy) {
        setFeedback('上一项操作仍在等待响应；当前输入已保留。')
        return
      }
      if (slashCommandMenuOpen && !parseLocalAgentSlashCommand(input)?.definition) {
        const selected = slashCommandSuggestions[slashCommandIndexRef.current]
        if (selected) completeSlashCommand(selected)
        return
      }
      if (!decision && !input && focusedToolId) {
        setExpandedToolIds(current => toggleReadonlySet(current, focusedToolId))
        return
      }
      submitInput()
      return
    }
    if (key.backspace) {
      setEditor(current => removeAgentInputBefore(current))
      setHistoryState({ index: null, draft: '' })
      return
    }
    if (key.delete) {
      setEditor(current => removeAgentInputAt(current))
      setHistoryState({ index: null, draft: '' })
      return
    }
    if (key.ctrl && value === 'u') {
      setEditor({ value: '', cursorIndex: 0 })
      setHistoryState({ index: null, draft: '' })
      return
    }
    if (key.leftArrow) {
      setEditor(current => moveAgentInputHorizontal(current, -1))
      return
    }
    if (key.rightArrow) {
      setEditor(current => moveAgentInputHorizontal(current, 1))
      return
    }
    if (key.home) {
      setEditor(current => moveAgentInputToLineBoundary(current, 'start'))
      return
    }
    if (key.end) {
      if (!input || key.ctrl) {
        setScroll(FOLLOW_AGENT_TIMELINE)
        setFeedback('已恢复跟随最新消息。')
        return
      }
      setEditor(current => moveAgentInputToLineBoundary(current, 'end'))
      return
    }
    if (key.ctrl || key.meta) return
    if (value && !/^\u001b/u.test(value)) {
      setEditor(current => insertAgentInput(current, value, MAX_INPUT_LENGTH))
      setHistoryState({ index: null, draft: '' })
      setFocusedToolId(null)
    }
  }, { isActive: columns >= MIN_COLUMNS && rows >= MIN_ROWS })

  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    return <AgentSizeWarning columns={columns} rows={rows} onExit={disconnect} />
  }

  const activity = describeAgentActivity(snapshot, busy)

  return (
    <LocalConsoleMouseProvider source={mouse}>
      <Box width={columns} height={rows} flexDirection="column" backgroundColor={consolePalette.canvas}>
        <AgentHeader snapshot={snapshot} dense={dense} />
        {help
          ? <HelpView compact={dense} onClose={() => setHelp(false)} />
          : statusOpen
            ? <StatusView
                snapshot={snapshot}
                identity={identity}
                compact={dense}
                onClose={() => setStatusOpen(false)}
              />
          : historyOpen
            ? <HistoryView
                threads={visibleThreads}
                selectedIndex={threadIndex}
                query={historyQuery}
                compact={dense}
                disabled={busy}
                onSelect={setThreadIndex}
                onOpen={thread => {
                  void runAction(async () => {
                    await session.openThread(thread.id)
                    setHistoryOpen(false)
                    setScroll(FOLLOW_AGENT_TIMELINE)
                    setFocusedToolId(null)
                    setFeedback(`已打开对话：${thread.title}`)
                  })
                }}
                onClose={() => setHistoryOpen(false)}
              />
            : <Box flexGrow={1} minHeight={0}>
              <MouseRegion
                flexDirection="column"
                flexGrow={1}
                minWidth={0}
                borderStyle="round"
                borderColor={activity ? consolePalette.borderStrong : consolePalette.border}
                backgroundColor={consolePalette.panel}
                paddingX={1}
                onWheel={direction => setScroll(current => scrollAgentTimeline(
                  allLines,
                  contentRows,
                  current,
                  direction < 0 ? -3 : 3,
                ))}
              >
                <Box justifyContent="space-between">
                  {activity
                    ? <AgentActivityIndicator
                        activity={activity}
                        animationsEnabled={animationsEnabled}
                        compact={compact}
                      />
                    : <Text bold color={consolePalette.focus}>
                        <Text color={consolePalette.accent}>◆</Text> 智能体时间线
                      </Text>}
                  <Text color={consolePalette.muted}>
                    {timelineWindow.following
                      ? '● 跟随最新'
                      : timelineWindow.unseenLines
                        ? `↑ 浏览历史 · 新增 ${timelineWindow.unseenLines} 行`
                        : '↑ 浏览历史'}
                    {compact ? '' : ' · 滚轮/PgUp/PgDn'}
                  </Text>
                </Box>
                {timelineWindow.lines.map(line => (
                  <AgentTimelineLine
                    key={line.key}
                    line={line}
                    focused={Boolean(line.toolId && line.toolId === focusedToolId)}
                    {...(line.toolHeader && line.toolId
                      ? { onToggle: () => {
                          const toolId = line.toolId
                          if (!toolId) return
                          setFocusedToolId(toolId)
                          setExpandedToolIds(current => toggleReadonlySet(current, toolId))
                        } }
                      : {})}
                  />
                ))}
              </MouseRegion>
              {wide && <AgentInspector snapshot={snapshot} />}
            </Box>}
        {decision && !help && !historyOpen && !statusOpen && <DecisionPanel
          decision={decision}
          selectedIndex={decisionIndex}
          armed={approvalArmed}
          compact={dense}
          disabled={busy}
          onSelect={index => {
            decisionIndexRef.current = index
            setDecisionIndex(index)
            setApprovalArmed(false)
          }}
          onSubmit={option => submitDecision(option)}
        />}
        {slashCommandMenuOpen && !help && !historyOpen && !statusOpen && <SlashCommandPanel
          commands={slashCommandSuggestions}
          selectedIndex={slashCommandIndex}
          compact={dense}
          onSelect={index => {
            slashCommandIndexRef.current = index
            setSlashCommandIndex(index)
          }}
          onComplete={completeSlashCommand}
        />}
        {!statusOpen && <AgentComposer
          viewport={editorViewport}
          valueLength={agentInputLength(input)}
          hasValue={Boolean(input)}
          height={composerHeight}
          compact={dense}
          busy={busy}
          decision={decision}
          onFocusLatest={() => setScroll(FOLLOW_AGENT_TIMELINE)}
        />}
        <AgentFooter
          snapshot={snapshot}
          feedback={snapshot.error ?? feedback}
          compact={dense}
          busy={busy}
        />
      </Box>
    </LocalConsoleMouseProvider>
  )
}

function AgentHeader({
  snapshot,
  dense,
}: {
  snapshot: LocalAgentSessionSnapshot
  dense: boolean
}) {
  const run = runPresentation(snapshot.run?.status)
  const online = snapshot.connection === 'online'
  const runColor = lineColor(run.tone)
  if (dense) {
    return (
      <Box
        flexShrink={0}
        borderStyle="single"
        borderColor={online ? consolePalette.focus : consolePalette.warning}
        backgroundColor={consolePalette.panelSoft}
        paddingX={1}
      >
        <Text bold color={consolePalette.focus}>{PRODUCT_CODENAME_UPPER}</Text>
        <Text color={consolePalette.muted}> · {online ? '在线' : '重连'} · </Text>
        <Text bold color={runColor}>{run.symbol} {run.label}</Text>
        <Text wrap="truncate-end" color={consolePalette.muted}>
          {' · '}{snapshot.provider?.displayName ?? '等待提供商'} / {snapshot.model ?? '等待模型'}
        </Text>
      </Box>
    )
  }
  return (
    <Box
      flexShrink={0}
      borderStyle="double"
      borderColor={online ? consolePalette.focus : consolePalette.warning}
      backgroundColor={consolePalette.panelSoft}
      paddingX={1}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        <Box>
          <Text bold color={consolePalette.canvas} backgroundColor={consolePalette.focus}>
            {' '}{PRODUCT_CODENAME_UPPER}{' '}
          </Text>
          <Text bold color={consolePalette.accent}> 智能体终端 </Text>
        </Box>
        <Box gap={1}>
          <Text
            bold
            color={consolePalette.canvas}
            backgroundColor={online ? consolePalette.healthy : consolePalette.warning}
          >
            {online ? ' ● 在线 ' : ' ◐ 重连 '}
          </Text>
          <Text bold color={consolePalette.canvas} backgroundColor={runColor}>
            {' '}{run.symbol} {run.label}{' '}
          </Text>
        </Box>
      </Box>
      <Box minWidth={0}>
        <Text bold color={consolePalette.info}>{snapshot.provider?.displayName ?? '等待提供商'}</Text>
        <Text color={consolePalette.text}> / {snapshot.model ?? '等待模型'} </Text>
        <Text
          bold
          color={consolePalette.canvas}
          backgroundColor={snapshot.executionMode === 'plan' ? consolePalette.accent : consolePalette.info}
        >
          {' '}{snapshot.executionMode === 'plan' ? '计划' : '自动'}{' '}
        </Text>
        <Text> </Text>
        <Text
          bold
          color={consolePalette.canvas}
          backgroundColor={snapshot.reasoning ? consolePalette.reasoning : consolePalette.muted}
        >
          {' '}{snapshot.reasoning ? '思考开启' : '思考关闭'}{' '}
        </Text>
      </Box>
    </Box>
  )
}

function AgentInspector({ snapshot }: { snapshot: LocalAgentSessionSnapshot }) {
  const run = snapshot.run
  const workflow = run?.state.agentWorkflow
  const tools = snapshot.items.filter(item => item.itemType === 'function_call')
  const completedTools = snapshot.items.filter(item => item.itemType === 'function_call_output' && !item.isError)
  const presentation = runPresentation(run?.status)
  return (
    <Box
      width={44}
      flexShrink={0}
      flexDirection="column"
      borderStyle="round"
      borderColor={consolePalette.accent}
      backgroundColor={consolePalette.panelSoft}
      paddingX={1}
    >
      <Text bold color={consolePalette.canvas} backgroundColor={consolePalette.accent}> 运行检查器 </Text>
      <Text bold color={lineColor(presentation.tone)}>
        {presentation.symbol} {presentation.label}
      </Text>
      <Text color={consolePalette.muted}>运行 {shortId(run?.id)} · 线程 {shortId(snapshot.threadId)}</Text>
      <Text>
        <Text color={consolePalette.healthy}>工具</Text> <Text bold>{completedTools.length}/{tools.length}</Text>
        <Text color={consolePalette.muted}>  ·  </Text>
        <Text color={consolePalette.info}>子智能体</Text> <Text bold>{run?.state.subAgents.length ?? 0}</Text>
      </Text>
      <Text>
        <Text color={consolePalette.accent}>产物</Text> <Text bold>{run?.state.artifacts.length ?? 0}</Text>
        <Text color={consolePalette.muted}>  ·  </Text>
        <Text color={consolePalette.warning}>待办</Text> <Text bold>{run?.state.todos.filter(todo => todo.status !== 'completed').length ?? 0}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold color={consolePalette.info}>
          ─ 计划 {workflow ? `${workflow.steps.filter(step => step.status === 'completed').length}/${workflow.steps.length}` : ''}
        </Text>
        {(workflow?.steps ?? []).slice(0, 10).map(step => (
          <Text key={step.stepId} color={step.status === 'failed'
            ? consolePalette.danger
            : step.status === 'completed' ? consolePalette.healthy : step.status === 'running' ? consolePalette.warning : consolePalette.muted}>
            {step.status === 'completed' ? '✓' : step.status === 'running' ? '▶' : step.status === 'failed' ? '✕' : '○'} {step.title}
          </Text>
        ))}
        {!workflow && <Text color={consolePalette.muted}>本次运行尚未生成工作流。</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold color={consolePalette.reasoning}>─ 智能体</Text>
        {(run?.state.subAgents ?? []).slice(0, 6).map(agent => (
          <Text key={agent.agentId} color={agent.status === 'failed' ? consolePalette.danger : consolePalette.muted}>
            {agent.status === 'running' ? '↗' : agent.status === 'completed' ? '✓' : '○'} {agent.name}
          </Text>
        ))}
        {!run?.state.subAgents.length && <Text color={consolePalette.muted}>当前仅主智能体运行。</Text>}
      </Box>
    </Box>
  )
}

function StatusView({
  snapshot,
  identity,
  compact,
  onClose,
}: {
  snapshot: LocalAgentSessionSnapshot
  identity: LocalAgentConsoleIdentity
  compact: boolean
  onClose: () => void
}) {
  const run = runPresentation(snapshot.run?.status)
  return (
    <Box
      flexGrow={1}
      minHeight={0}
      borderStyle="round"
      borderColor={consolePalette.focus}
      backgroundColor={consolePalette.panel}
      paddingX={1}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        <Text bold color={consolePalette.focus}>运行状态</Text>
        <MouseRegion onClick={onClose} priority={50}>
          <Text color={consolePalette.muted}>Enter/Esc 关闭</Text>
        </MouseRegion>
      </Box>
      <Text wrap="wrap">
        <Text color={consolePalette.muted}>连接：</Text>{snapshot.connectionMessage}
        <Text color={consolePalette.muted}> · 运行：</Text>{run.symbol} {run.label}
      </Text>
      <Text wrap="wrap">
        <Text color={consolePalette.muted}>模型：</Text>
        {snapshot.provider?.displayName ?? '未连接'} / {snapshot.model ?? '未配置'}
        <Text color={consolePalette.muted}> · 模式：</Text>{snapshot.executionMode === 'auto' ? '自动' : '计划'}
        {!compact && <Text color={consolePalette.muted}> · 思考：{snapshot.reasoning ? '开启' : '关闭'}</Text>}
      </Text>
      <Text wrap="wrap">
        <Text color={consolePalette.muted}>版本：</Text>{identity.version}
        <Text color={consolePalette.muted}> · 本地主体：</Text>{identity.osUser}@{identity.hostname}
        <Text color={consolePalette.muted}> · 密钥版本：</Text>{identity.keyVersion}
      </Text>
      <Text wrap="wrap"><Text color={consolePalette.muted}>项目：</Text>{identity.projectRoot}</Text>
      <Text wrap="wrap">
        <Text color={consolePalette.muted}>线程：</Text>{snapshot.threadId ?? '尚未创建'}
        <Text color={consolePalette.muted}> · 运行编号：</Text>{snapshot.run?.id ?? '尚未创建'}
      </Text>
      {snapshot.error && <Text wrap="wrap" color={consolePalette.danger}>错误：{snapshot.error}</Text>}
    </Box>
  )
}

function AgentTimelineLine({
  line,
  focused,
  onToggle,
}: {
  line: AgentDisplayLine
  focused: boolean
  onToggle?: () => void
}) {
  const content = (hovered = false) => (
    <Text
      {...(line.bold ? { bold: true } : {})}
      color={lineColor(line.tone)}
      {...(line.user || focused || hovered ? { backgroundColor: consolePalette.panelRaised } : {})}
      wrap="truncate-end"
    >
      {line.toolHeader ? (focused ? '› ' : '  ') : ''}{line.rendered ?? line.text}
    </Text>
  )
  if (!onToggle) return content()
  return (
    <MouseRegion onClick={onToggle} priority={25}>
      {state => content(state.hovered)}
    </MouseRegion>
  )
}

function HistoryView({
  threads,
  selectedIndex,
  query,
  compact,
  disabled,
  onSelect,
  onOpen,
  onClose,
}: {
  threads: readonly AgentThreadRecord[]
  selectedIndex: number
  query: string
  compact: boolean
  disabled: boolean
  onSelect: (index: number) => void
  onOpen: (thread: AgentThreadRecord) => void
  onClose: () => void
}) {
  const maximumVisible = compact ? 3 : 8
  const firstVisibleIndex = Math.min(
    Math.max(0, selectedIndex - maximumVisible + 1),
    Math.max(0, threads.length - maximumVisible),
  )
  const visibleThreads = threads.slice(firstVisibleIndex, firstVisibleIndex + maximumVisible)
  return (
    <Box
      flexGrow={1}
      minHeight={0}
      borderStyle="round"
      borderColor={consolePalette.focus}
      backgroundColor={consolePalette.panel}
      paddingX={1}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        <Text bold color={consolePalette.focus}>最近对话</Text>
        <MouseRegion disabled={disabled} onClick={onClose} priority={50}>
          <Text color={consolePalette.muted}>Esc 关闭</Text>
        </MouseRegion>
      </Box>
      <Text wrap="truncate-end" color={consolePalette.muted}>
        筛选：{query || '直接输入标题或内容'} · ↑↓ 选择 · Enter 打开
      </Text>
      {!visibleThreads.length && <Text color={consolePalette.muted}>没有匹配的对话。</Text>}
      {visibleThreads.map((thread, visibleIndex) => {
        const index = firstVisibleIndex + visibleIndex
        const selected = index === selectedIndex
        const summary = thread.latestUserQuery ?? thread.latestAssistantSummary ?? thread.historyPreview
        return (
          <MouseRegion
            key={thread.id}
            disabled={disabled}
            onClick={() => selected ? onOpen(thread) : onSelect(index)}
            priority={40}
          >
            {state => <Text
              bold={selected || state.hovered}
              color={selected ? consolePalette.canvas : consolePalette.text}
              {...(selected
                ? { backgroundColor: consolePalette.focus }
                : state.hovered ? { backgroundColor: consolePalette.selected } : {})}
              wrap="truncate-end"
            >
              {selected ? '›' : ' '} {thread.title}
              {summary ? ` · ${summary.replace(/\s+/gu, ' ').trim()}` : ''}
            </Text>}
          </MouseRegion>
        )
      })}
    </Box>
  )
}

function DecisionPanel({
  decision,
  selectedIndex,
  armed,
  compact,
  disabled,
  onSelect,
  onSubmit,
}: {
  decision: DecisionRequest
  selectedIndex: number
  armed: boolean
  compact: boolean
  disabled: boolean
  onSelect: (index: number) => void
  onSubmit: (option: DecisionRequest['options'][number]) => void
}) {
  const maximumVisible = compact ? 1 : MAX_VISIBLE_DECISION_OPTIONS
  const firstVisibleIndex = Math.min(
    Math.max(0, selectedIndex - maximumVisible + 1),
    Math.max(0, decision.options.length - maximumVisible),
  )
  const visibleOptions = decision.options.slice(
    firstVisibleIndex,
    firstVisibleIndex + maximumVisible,
  )
  return (
    <Box flexShrink={0} borderStyle="round" borderColor={decision.kind === 'approval' ? consolePalette.warning : consolePalette.focus} paddingX={1} flexDirection="column">
      <Text bold color={decision.kind === 'approval' ? consolePalette.warning : consolePalette.focus}>
        {decision.kind === 'approval' ? '! 等待批准' : '? 需要澄清'} · <Text wrap="truncate-end">{compact ? decision.question : decision.title}</Text>
        {decision.options.length ? ` · ${selectedIndex + 1}/${decision.options.length}` : ''}
      </Text>
      {!compact && <Text wrap="truncate-end">{decision.question}</Text>}
      <Box flexDirection="column">
        {visibleOptions.map((option, visibleIndex) => {
          const index = firstVisibleIndex + visibleIndex
          const selected = index === selectedIndex
          const dangerous = option.payload.approved === true
          return (
            <MouseRegion
              key={option.optionId ?? `${decision.decisionId}:${index}`}
              disabled={disabled}
              onClick={() => {
                if (selected) onSubmit(option)
                else onSelect(index)
              }}
              priority={40}
            >
              {state => <Text
                bold={selected || state.hovered}
                color={selected ? consolePalette.canvas : dangerous ? consolePalette.warning : consolePalette.text}
                {...(selected
                  ? { backgroundColor: dangerous && armed ? consolePalette.danger : consolePalette.focus }
                  : state.hovered ? { backgroundColor: consolePalette.selected } : {})}
                wrap="truncate-end"
              > {selected ? '›' : ' '} {option.label}
                {!compact && option.description ? ` · ${option.description}` : ''}
                {dangerous && armed && selected ? ' · 再次确认' : ''}
              </Text>}
            </MouseRegion>
          )
        })}
      </Box>
    </Box>
  )
}

function AgentComposer({
  viewport,
  valueLength,
  hasValue,
  height,
  compact,
  busy,
  decision,
  onFocusLatest,
}: {
  viewport: AgentInputViewport
  valueLength: number
  hasValue: boolean
  height: number
  compact: boolean
  busy: boolean
  decision: DecisionRequest | null
  onFocusLatest: () => void
}) {
  const placeholder = decision?.kind === 'clarification'
    ? '输入补充说明，或用 ↑↓ 选择上方选项…'
    : decision?.kind === 'approval'
      ? '审批期间请选择上方选项；可输入 /help…'
      : '输入消息…'
  return (
    <MouseRegion
      flexShrink={0}
      height={height}
      borderStyle="round"
      borderColor={busy ? consolePalette.warning : consolePalette.focus}
      backgroundColor={consolePalette.panelSoft}
      paddingX={1}
      onClick={onFocusLatest}
      priority={20}
    >
      {compact
        ? <Text wrap="truncate-end" color={consolePalette.text}>
            <Text color={consolePalette.info}>› </Text>
            {viewport.before}<Text inverse color={consolePalette.canvas} backgroundColor={consolePalette.focus}>{busy ? ' ' : viewport.cursor}</Text>{viewport.after}
            {!hasValue && <Text color={consolePalette.muted}>{placeholder}</Text>}
          </Text>
        : <Box flexDirection="column" width="100%">
        <Text>
          <Text bold color={consolePalette.canvas} backgroundColor={busy ? consolePalette.warning : consolePalette.focus}>
            {busy ? ' 提交中 ' : ' 输入 '}
          </Text>
          <Text color={consolePalette.muted}> {hasValue ? `${valueLength}/${MAX_INPUT_LENGTH}` : placeholder}</Text>
        </Text>
        <Text wrap="wrap" color={consolePalette.text}>
          <Text color={consolePalette.info}>› </Text>
          {viewport.before}<Text inverse color={consolePalette.canvas} backgroundColor={consolePalette.focus}>{busy ? ' ' : viewport.cursor}</Text>{viewport.after}
        </Text>
      </Box>}
    </MouseRegion>
  )
}

function SlashCommandPanel({
  commands,
  selectedIndex,
  compact,
  onSelect,
  onComplete,
}: {
  commands: readonly LocalAgentSlashCommandDefinition[]
  selectedIndex: number
  compact: boolean
  onSelect: (index: number) => void
  onComplete: (command: LocalAgentSlashCommandDefinition) => void
}) {
  const maximumVisible = compact ? 3 : MAX_VISIBLE_SLASH_COMMANDS
  const firstVisibleIndex = Math.min(
    Math.max(0, selectedIndex - maximumVisible + 1),
    Math.max(0, commands.length - maximumVisible),
  )
  const visibleCommands = commands.slice(
    firstVisibleIndex,
    firstVisibleIndex + maximumVisible,
  )
  return (
    <Box
      flexShrink={0}
      borderStyle="round"
      borderColor={consolePalette.accent}
      backgroundColor={consolePalette.panel}
      paddingX={1}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        <Text bold color={consolePalette.accent}>/ 斜杠命令</Text>
        <Text color={consolePalette.muted}>
          {commands.length > maximumVisible ? `${selectedIndex + 1}/${commands.length} · ` : ''}
          {compact ? '↑↓ · Tab/Enter · Esc' : '↑↓ 选择 · Tab/Enter 补全 · Esc 关闭'}
        </Text>
      </Box>
      {visibleCommands.map((command, visibleIndex) => {
        const index = firstVisibleIndex + visibleIndex
        const selected = index === selectedIndex
        return (
          <MouseRegion
            key={command.id}
            onClick={() => {
              if (selected) onComplete(command)
              else onSelect(index)
            }}
            priority={35}
          >
            {state => <Text
              bold={selected || state.hovered}
              color={selected ? consolePalette.canvas : consolePalette.text}
              {...(selected
                ? { backgroundColor: consolePalette.accent }
                : state.hovered ? { backgroundColor: consolePalette.selected } : {})}
              wrap="truncate-end"
            >
              {selected ? '›' : ' '} {compact ? command.usage : `${command.usage.padEnd(20)} ${command.description}`}
            </Text>}
          </MouseRegion>
        )
      })}
    </Box>
  )
}

function AgentFooter({
  snapshot,
  feedback,
  compact,
  busy,
}: {
  snapshot: LocalAgentSessionSnapshot
  feedback: string
  compact: boolean
  busy: boolean
}) {
  const run = runPresentation(snapshot.run?.status)
  const status = `${snapshot.connection === 'online' ? '●' : '◐'} ${snapshot.connectionMessage} · ${run.symbol} ${run.label} · ${snapshot.provider?.displayName ?? '未连接'} / ${snapshot.model ?? '未配置'}`
  if (compact) {
    return (
      <Box
        flexShrink={0}
        borderStyle="single"
        borderColor={snapshot.error ? consolePalette.danger : consolePalette.borderStrong}
        backgroundColor={consolePalette.panel}
        paddingX={1}
      >
        <Text wrap="truncate-end" color={snapshot.error ? consolePalette.danger : consolePalette.text}>
          {snapshot.error ?? `${status} · ${busy ? '等待响应' : 'Enter 发送'} · ^C 取消/分离`}
        </Text>
      </Box>
    )
  }
  return (
    <Box
      flexShrink={0}
      borderStyle="single"
      borderColor={consolePalette.borderStrong}
      backgroundColor={consolePalette.panel}
      paddingX={1}
      flexDirection="column"
    >
      <Text wrap="truncate-end" color={snapshot.connection === 'online' ? consolePalette.text : consolePalette.warning}>
        {status}
      </Text>
      <Text wrap="truncate-end">
        <Text color={snapshot.error ? consolePalette.danger : consolePalette.text}>{feedback}</Text>
        <Text color={consolePalette.muted}> · Enter 发送 · Ctrl+J 换行 · Ctrl+C 取消/分离 · ? 帮助</Text>
      </Text>
    </Box>
  )
}

function HelpView({ compact, onClose }: { compact: boolean; onClose: () => void }) {
  return (
    <Box
      flexGrow={1}
      borderStyle="double"
      borderColor={consolePalette.accent}
      backgroundColor={consolePalette.panel}
      paddingX={compact ? 1 : 2}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        <Text bold color={consolePalette.canvas} backgroundColor={consolePalette.accent}> 快捷键与命令 </Text>
        <MouseRegion onClick={onClose} priority={50}><Text bold color={consolePalette.focus}> 关闭 </Text></MouseRegion>
      </Box>
      <Text wrap="truncate-end">Enter 发送 · Ctrl+J 换行 · ↑↓ 输入历史/决策 · Tab 工具 · PgUp/PgDn 浏览 · End 底部</Text>
      <Text wrap="truncate-end">Ctrl+C：取消/清空；连续两次分离 · Ctrl+D 空输入分离</Text>
      <Text wrap="truncate-end" color={consolePalette.warning}>审批默认“拒绝”；批准必须再次确认。</Text>
      {!compact && localAgentSlashCommands.map(command => (
        <Text key={command.id}>
          <Text bold color={consolePalette.info}>{command.usage.padEnd(20)}</Text>
          {command.description}
        </Text>
      ))}
      {!compact && <Text color={consolePalette.muted}>普通字母（包括 q、?、S、R）在输入区只会作为文本，不会触发运维操作。</Text>}
      {!compact && <Text color={consolePalette.muted}>鼠标只捕获点击与滚轮；终端原生文本选择不启用移动追踪。</Text>}
    </Box>
  )
}

function AgentSizeWarning({
  columns,
  rows,
  onExit,
}: {
  columns: number
  rows: number
  onExit: () => void
}) {
  useInput((value, key) => {
    if ((key.ctrl && value === 'c') || (key.ctrl && value === 'd')) onExit()
  })
  return (
    <Box width={Math.max(1, columns)} height={Math.max(1, rows)} justifyContent="center" alignItems="center" flexDirection="column">
      <Text bold color={consolePalette.warning}>终端尺寸不足，Agent 界面已暂停渲染。</Text>
      <Text>当前 {columns}×{rows}，至少需要 {MIN_COLUMNS}×{MIN_ROWS}。</Text>
      <Text color={consolePalette.muted}>请放大窗口；Ctrl+C 或 Ctrl+D 分离，不停止后台服务。</Text>
    </Box>
  )
}

function pendingDecision(snapshot: LocalAgentSessionSnapshot): DecisionRequest | null {
  const decisions = snapshot.run?.state.decisions ?? []
  return decisions.find(item => item.status === 'pending' && item.kind === 'approval')
    ?? decisions.find(item => item.status === 'pending' && item.kind === 'clarification')
    ?? null
}

function lineColor(tone: AgentLineTone): string {
  if (tone === 'focus') return consolePalette.focus
  if (tone === 'info') return consolePalette.info
  if (tone === 'accent') return consolePalette.accent
  if (tone === 'reasoning') return consolePalette.reasoning
  if (tone === 'healthy') return consolePalette.healthy
  if (tone === 'warning') return consolePalette.warning
  if (tone === 'danger') return consolePalette.danger
  if (tone === 'muted') return consolePalette.muted
  return consolePalette.text
}

function toggleReadonlySet(current: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(current)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function shortId(value: string | null | undefined): string {
  if (!value) return '—'
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}

function formatUiError(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : '未知错误。'
  return `操作失败：${message.replace(/[\r\n]+/gu, ' ').slice(0, 500)}；未确认的写操作不会自动重放。`
}

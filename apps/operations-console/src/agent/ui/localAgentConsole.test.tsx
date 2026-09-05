// +-------------------------------------------------------------------------
//
//   地理智能平台 - 中文本机 Agent 终端测试
//
//   文件:       localAgentConsole.test.tsx
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import {
  analysisRunSchema,
  conversationItemSchema,
  workspaceBootstrapSnapshotSchema,
  type AgentExecutionMode,
  type AgentThreadRecord,
  type AnalysisRun,
  type DecisionRequest,
} from '@geo-agent-platform/shared-types'
import { PRODUCT_CODENAME_UPPER } from '@geo-agent-platform/shared-types/product-identity'
import { ThemeProvider } from '@inkjs/ui'
import { cleanup, render } from 'ink-testing-library'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { platformConsoleTheme } from '../../localConsoleTheme.js'
import type { TerminalMouseEvent, TerminalMouseSource } from '../../terminalMouse.js'
import type { LocalAgentSessionSnapshot } from '../application/localAgentSession.js'
import {
  LocalAgentConsoleApp,
  type LocalAgentConsoleIdentity,
  type LocalAgentConsoleSession,
} from './localAgentConsole.js'

afterEach(() => cleanup())

describe('LocalAgentConsoleApp', () => {
  it.each([
    [60, 16, '智能体时间线'],
    [80, 24, PRODUCT_CODENAME_UPPER],
    [120, 30, '输入消息'],
    [140, 32, '运行检查器'],
    [180, 36, '本次运行尚未生成工作流'],
  ])('renders a stable high-density layout at %ix%i', async (columns, rows, expected) => {
    const instance = renderConsole(new TestSession(snapshot()))
    resize(instance.stdout, columns, rows)

    await vi.waitFor(() => {
      expect(instance.lastFrame()).toContain(expected)
      assertFrameFits(instance.lastFrame(), columns, rows)
    })
  })

  it('fits the compact interaction layout at 60x16', async () => {
    const instance = renderConsole(new TestSession(snapshot()))
    resize(instance.stdout, 60, 16)

    await vi.waitFor(() => {
      expect(instance.lastFrame()).toContain('智能体时间线')
      expect(instance.lastFrame()).toContain('输入消息')
      assertFrameFits(instance.lastFrame(), 60, 16)
    })
  })

  it('pauses rendering below 60x16 without corrupting the viewport', async () => {
    const instance = renderConsole(new TestSession(snapshot()))
    resize(instance.stdout, 59, 15)

    await vi.waitFor(() => expect(instance.lastFrame()).toContain('终端尺寸不足'))
    expect(instance.lastFrame()).toContain('至少需要 60×16')
    assertFrameFits(instance.lastFrame(), 59, 15)
  })

  it('treats ordinary letters as input and supports cursor-aware insertion', async () => {
    const session = new TestSession(snapshot())
    const instance = renderConsole(session)
    resize(instance.stdout, 100, 30)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('输入消息'))

    instance.stdin.write('天气')
    instance.stdin.write('\u001b[D')
    instance.stdin.write('好')
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('天好气'))
    expect(session.close).not.toHaveBeenCalled()

    instance.stdin.write('\r')
    await vi.waitFor(() => expect(session.submit).toHaveBeenCalledWith('天好气'))
  })

  it('edits Chinese and emoji by grapheme instead of splitting a visible character', async () => {
    const instance = renderConsole(new TestSession(snapshot(run('completed'))))
    resize(instance.stdout, 100, 30)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('输入消息'))

    instance.stdin.write('A👨‍👩‍👧‍👦中')
    instance.stdin.write('\u001b[D')
    instance.stdin.write('\u007f')

    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('A中')
      expect(frame).not.toContain('👨‍👩‍👧‍👦')
    })
  })

  it('recalls multiple inputs and restores the unsent draft', async () => {
    const session = new TestSession(snapshot(run('completed')))
    const instance = renderConsole(session)
    resize(instance.stdout, 100, 30)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('输入消息'))

    instance.stdin.write('第一问')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('第一问'))
    instance.stdin.write('\r')
    await vi.waitFor(() => expect(session.submit).toHaveBeenCalledTimes(1))
    instance.stdin.write('第二问')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('第二问'))
    instance.stdin.write('\r')
    await vi.waitFor(() => expect(session.submit).toHaveBeenCalledTimes(2))
    instance.stdin.write('草稿')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('草稿'))

    instance.stdin.write('\u001b[A')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('第二问'))
    instance.stdin.write('\u001b[A')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('第一问'))
    instance.stdin.write('\u001b[B')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('第二问'))
    instance.stdin.write('\u001b[B')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('草稿'))
  })

  it('keeps editing available while a submission waits and keeps Ctrl+C global', async () => {
    const session = new TestSession(snapshot(run('completed')))
    let resolveSubmit: ((value: AnalysisRun) => void) | null = null
    session.submit.mockImplementationOnce(() => new Promise(resolve => {
      resolveSubmit = resolve
    }))
    const instance = renderConsole(session)
    resize(instance.stdout, 100, 30)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('输入消息'))

    instance.stdin.write('先提交')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('先提交'))
    instance.stdin.write('\r')
    await vi.waitFor(() => expect(session.submit).toHaveBeenCalledOnce())
    instance.stdin.write(
      '\u001b[200~下一条\t草稿\u0000\u001b[31m红色\u001b[0m\n第二行\u001b[201~',
    )
    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('下一条    草稿红色')
      expect(frame).toContain('第二行')
    })

    resolveSubmit?.(run('completed'))
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('问题已提交'))
    instance.stdin.write('\r')
    await vi.waitFor(() => expect(session.submit).toHaveBeenNthCalledWith(
      2,
      '下一条    草稿红色\n第二行',
    ))

    instance.stdin.write('\u0003')
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('再次按 Ctrl+C'))
    instance.stdin.write('\u0003')
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledOnce())
  })

  it('opens a filtered thread from the history selector', async () => {
    const value = snapshot(run('completed'))
    value.bootstrap = {
      ...bootstrapWithWeatherTool(),
      threads: [
        threadRecord('thread_1', '杭州天气', '查杭州降水'),
        threadRecord('thread_2', '第二个对话', '核验雷达回波'),
      ],
    }
    const session = new TestSession(value)
    const instance = renderConsole(session)
    resize(instance.stdout, 100, 30)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('输入消息'))

    instance.stdin.write('/history')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('› /history'))
    instance.stdin.write('\r')
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('最近对话'))
    instance.stdin.write('第二')
    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('第二个对话')
      expect(frame).not.toContain('杭州天气')
    })
    instance.stdin.write('\r')
    await vi.waitFor(() => expect(session.openThread).toHaveBeenCalledWith('thread_2'))
  })

  it('opens and filters the slash-command menu, then completes and executes an exact command', async () => {
    const session = new TestSession(snapshot())
    const instance = renderConsole(session)
    resize(instance.stdout, 100, 32)
    await vi.waitFor(() => {
      expect(instance.lastFrame()).toContain('输入消息')
      expect(instance.lastFrame()).not.toContain(identity.projectRoot)
      expect(instance.lastFrame()).not.toContain(`v${identity.version}`)
    })

    instance.stdin.write('/')
    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('斜杠命令')
      expect(frame).toContain('/help')
      expect(frame).toContain('Tab/Enter 补全')
    })

    instance.stdin.write('st')
    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('/status')
      expect(frame).toContain('查看运行与连接状态')
      expect(frame).not.toContain('打开快捷键与命令帮助')
    })

    instance.stdin.write('\r')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('› /status'))
    instance.stdin.write('\r')
    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('运行状态')
      expect(frame).toContain('James@杭州开发机')
      expect(frame).toContain(identity.projectRoot)
    })
    expect(session.submit).not.toHaveBeenCalled()
  })

  it('supports arrow selection and Tab completion in the slash-command menu', async () => {
    const session = new TestSession(snapshot())
    const instance = renderConsole(session)
    resize(instance.stdout, 100, 32)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('输入消息'))

    instance.stdin.write('/')
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('斜杠命令'))
    instance.stdin.write('\u001b[B')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('› /new'))
    instance.stdin.write('\t')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('› /new'))
    instance.stdin.write('\r')
    await vi.waitFor(() => expect(session.newConversation).toHaveBeenCalledOnce())
  })

  it('scrolls the slash-command window so every registered command remains selectable', async () => {
    const session = new TestSession(snapshot())
    const instance = renderConsole(session)
    resize(instance.stdout, 100, 32)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('输入消息'))

    instance.stdin.write('/')
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('斜杠命令'))
    instance.stdin.write('\u001b[A')
    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('13/13')
      expect(frame).toContain('› /exit')
      expect(frame).not.toContain('打开快捷键与命令帮助')
      assertFrameFits(instance.lastFrame(), 100, 32)
    })
  })

  it('shows reasoning and assistant updates as canonical accumulated items', async () => {
    const value = snapshot(run('running'))
    value.items = [
      conversationItemSchema.parse({
        itemId: 'reasoning_1',
        itemType: 'reasoning',
        runId: 'run_1',
        threadId: 'thread_1',
        body: '先核验时次与地点，再读取降水数据。',
        status: 'running',
        timestamp: '2026-07-27T00:00:01.000Z',
      }),
      conversationItemSchema.parse({
        itemId: 'answer_1',
        itemType: 'message',
        runId: 'run_1',
        threadId: 'thread_1',
        role: 'assistant',
        body: '正在整理杭州天气结论。',
        status: 'running',
        timestamp: '2026-07-27T00:00:02.000Z',
      }),
    ]
    const instance = renderConsole(new TestSession(value))
    resize(instance.stdout, 140, 36)

    await vi.waitFor(() => {
      expect(instance.lastFrame()).toContain('先核验时次与地点')
      expect(instance.lastFrame()).toContain('正在整理杭州天气结论')
    })
  })

  it('shows a labelled reasoning activity even when motion is reduced', async () => {
    const value = snapshot(run('running'))
    value.items = [
      conversationItemSchema.parse({
        itemId: 'reasoning_active',
        itemType: 'reasoning',
        runId: 'run_1',
        threadId: 'thread_1',
        body: '正在核验杭州逐小时降水。',
        status: 'running',
        timestamp: '2026-07-27T00:00:01.000Z',
      }),
    ]
    const instance = renderConsole(new TestSession(value))
    resize(instance.stdout, 100, 30)

    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('◐ 正在推理')
      expect(frame).toContain('正在核验杭州逐小时降水')
      assertFrameFits(instance.lastFrame(), 100, 30)
    })
  })

  it('renders assistant Markdown through the terminal renderer at supported widths', async () => {
    const value = snapshot(run('completed'))
    value.items = [
      conversationItemSchema.parse({
        itemId: 'answer_markdown',
        itemType: 'message',
        runId: 'run_1',
        threadId: 'thread_1',
        role: 'assistant',
        body: [
          '# 杭州降水结论',
          '',
          '- **今天**：有阵雨',
          '- **明天**：降水减弱',
          '',
          '| 时段 | 风险 |',
          '| --- | --- |',
          '| 午后 | 中等 |',
          '',
          '```text',
          '数据已核验',
          '```',
        ].join('\n'),
        status: 'completed',
        timestamp: '2026-07-27T00:00:02.000Z',
      }),
    ]
    const instance = renderConsole(new TestSession(value))
    resize(instance.stdout, 100, 40)

    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('杭州降水结论')
      expect(frame).toContain('今天：有阵雨')
      expect(frame).toContain('时段')
      expect(frame).toContain('数据已核验')
      expect(frame).not.toContain('**今天**')
      expect(frame).not.toContain('```text')
      assertFrameFits(instance.lastFrame(), 100, 40)
    })
  })

  it('collapses completed tools by default and expands the selected tool with Tab and Enter', async () => {
    const value = snapshot(run('completed'))
    value.bootstrap = bootstrapWithWeatherTool()
    value.items = [
      conversationItemSchema.parse({
        itemId: 'tool_output',
        itemType: 'function_call_output',
        runId: 'run_1',
        threadId: 'thread_1',
        callId: 'call_weather',
        output: '{"summary":"杭州午后有阵雨。"}',
        status: 'completed',
        timestamp: '2026-07-27T00:00:02.000Z',
      }),
      conversationItemSchema.parse({
        itemId: 'tool_call',
        itemType: 'function_call',
        runId: 'run_1',
        threadId: 'thread_1',
        callId: 'call_weather',
        name: 'query_public_weather',
        arguments: '{"location":"杭州"}',
        status: 'completed',
        timestamp: '2026-07-27T00:00:01.000Z',
      }),
    ]
    const instance = renderConsole(new TestSession(value))
    resize(instance.stdout, 100, 34)

    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('已调用工具 · 查询公开天气 [query_public_weather]')
      expect(frame).not.toContain('{"location":"杭州"}')
    })
    instance.stdin.write('\t')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('› ✓ 已调用工具'))
    instance.stdin.write('\r')
    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('输入')
      expect(frame).toContain('{"location":"杭州"}')
      expect(frame).toContain('输出')
      expect(frame).toContain('杭州午后有阵雨。')
    })
  })

  it('scrolls a Tab-focused historical tool into view without replaying from the top', async () => {
    const value = snapshot(run('completed'))
    const base = bootstrapWithWeatherTool()
    const descriptor = base.tools[0]
    if (!descriptor) throw new Error('测试工具不存在。')
    value.bootstrap = {
      ...base,
      tools: [
        { ...descriptor, name: 'old_tool', label: '旧工具' },
        { ...descriptor, name: 'new_tool', label: '新工具' },
      ],
    }
    value.items = [
      ...Array.from({ length: 8 }, (_, index) => conversationItemSchema.parse({
        itemId: `answer_before_${index}`,
        itemType: 'message',
        runId: 'run_1',
        threadId: 'thread_1',
        role: 'assistant',
        body: `开头消息 ${index + 1}`,
        status: 'completed',
        timestamp: `2026-07-27T00:00:${String(index).padStart(2, '0')}.000Z`,
      })),
      ...toolPair('old', 'old_tool', '旧工具结果', 10),
      ...Array.from({ length: 24 }, (_, index) => conversationItemSchema.parse({
        itemId: `answer_between_${index}`,
        itemType: 'message',
        runId: 'run_1',
        threadId: 'thread_1',
        role: 'assistant',
        body: `中间消息 ${index + 1}`,
        status: 'completed',
        timestamp: `2026-07-27T00:00:${String(index + 2).padStart(2, '0')}.000Z`,
      })),
      ...toolPair('new', 'new_tool', '新工具结果', 40),
    ]
    const instance = renderConsole(new TestSession(value))
    resize(instance.stdout, 100, 30)

    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('新工具 [new_tool]')
      expect(frame).not.toContain('旧工具 [old_tool]')
    })
    instance.stdin.write('\t')
    await vi.waitFor(() => expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('› ✓ 已调用工具 · 新工具'))
    instance.stdin.write('\t')
    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('› ✓ 已调用工具 · 旧工具 [old_tool]')
      expect(frame).toContain('浏览历史')
      expect(frame).not.toContain('开头消息 1')
      assertFrameFits(instance.lastFrame(), 100, 30)
    })
  })

  it('defaults approval decisions to rejection and requires double confirmation to approve', async () => {
    const decision = approvalDecision()
    const value = snapshot(run('waiting_approval', [decision]))
    const rejecting = new TestSession(value)
    const rejectView = renderConsole(rejecting)
    resize(rejectView.stdout, 100, 30)
    await vi.waitFor(() => expect(rejectView.lastFrame()).toContain('› 拒绝'))

    rejectView.stdin.write('\r')
    await vi.waitFor(() => expect(rejecting.respondDecision).toHaveBeenCalledWith({
      decisionId: 'approval_1',
      optionId: 'reject',
    }))
    cleanup()

    const approving = new TestSession(snapshot(run('waiting_approval', [decision])))
    const approveView = renderConsole(approving)
    resize(approveView.stdout, 100, 30)
    await vi.waitFor(() => expect(approveView.lastFrame()).toContain('› 拒绝'))
    approveView.stdin.write('\u001b[A')
    approveView.stdin.write('\r')
    await vi.waitFor(() => expect(approveView.lastFrame()).toContain('再次确认'))
    expect(approving.respondDecision).not.toHaveBeenCalled()
    approveView.stdin.write('\r')
    await vi.waitFor(() => expect(approving.respondDecision).toHaveBeenCalledWith({
      decisionId: 'approval_1',
      optionId: 'approve',
    }))
  })

  it('keeps a long approval decision usable at 60x16', async () => {
    const decision = approvalDecision()
    decision.title = '执行可能修改数据的受保护工具'
    decision.question = '是否允许把经过核验的空间分析结果写入当前工作区？默认拒绝，不会产生任何变更。'
    decision.options[0] = { ...decision.options[0]!, description: '允许本次写入' }
    decision.options[1] = { ...decision.options[1]!, description: '保持现状' }
    const instance = renderConsole(new TestSession(snapshot(run('waiting_approval', [decision]))))
    resize(instance.stdout, 60, 16)

    await vi.waitFor(() => {
      expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toContain('› 拒绝')
      assertFrameFits(instance.lastFrame(), 60, 16)
    })
  })

  it.each([
    [80, 24],
    [120, 30],
    [140, 32],
  ])('windows every decision option list at %ix%i', async (columns, rows) => {
    const decision = clarificationDecision(10)
    const instance = renderConsole(new TestSession(snapshot(run('clarification_needed', [decision]))))
    resize(instance.stdout, columns, rows)

    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('1/10')
      expect(frame).toContain('› 决策选项 01')
      expect(frame).toContain('决策选项 04')
      expect(frame).not.toContain('决策选项 05')
      expect(frame).not.toContain('决策选项 10')
      assertFrameFits(instance.lastFrame(), columns, rows)
    })

    instance.stdin.write('\u001b[A')
    await vi.waitFor(() => {
      const frame = stripVTControlCharacters(instance.lastFrame() ?? '')
      expect(frame).toContain('10/10')
      expect(frame).toContain('› 决策选项 10')
      expect(frame).toContain('决策选项 07')
      expect(frame).not.toContain('决策选项 06')
      expect(frame).not.toContain('决策选项 01')
      assertFrameFits(instance.lastFrame(), columns, rows)
    })
  })

  it('uses End on an empty editor to resume following the latest timeline line', async () => {
    const value = snapshot(run('completed'))
    value.items = Array.from({ length: 30 }, (_, index) => conversationItemSchema.parse({
      itemId: `answer_${index}`,
      itemType: 'message',
      runId: 'run_1',
      threadId: 'thread_1',
      role: 'assistant',
      body: `第 ${index + 1} 条时间线消息`,
      status: 'completed',
      timestamp: `2026-07-27T00:00:${String(index).padStart(2, '0')}.000Z`,
    }))
    const instance = renderConsole(new TestSession(value))
    resize(instance.stdout, 80, 24)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('第 30 条时间线消息'))

    instance.stdin.write('\u001b[5~')
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('浏览历史'))
    instance.stdin.write('\u001b[F')
    await vi.waitFor(() => {
      expect(instance.lastFrame()).toContain('● 跟随最新')
      expect(instance.lastFrame()).toContain('第 30 条时间线消息')
    })
  })

  it('accepts mouse clicks for tool expansion without enabling motion capture', async () => {
    const mouse = new TestMouseSource()
    const value = snapshot(run('completed'))
    value.bootstrap = bootstrapWithWeatherTool()
    value.items = toolConversationItems()
    const session = new TestSession(value)
    const instance = renderConsole(session, mouse)
    resize(instance.stdout, 100, 30)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('已调用工具 · 查询公开天气'))
    await new Promise(resolve => setTimeout(resolve, 30))

    mouse.click(5, 7)

    await vi.waitFor(() => expect(instance.lastFrame()).toContain('{"location":"杭州"}'))
  })
})

class TestSession implements LocalAgentConsoleSession {
  private readonly events = new EventEmitter()
  private current: LocalAgentSessionSnapshot

  readonly close = vi.fn()
  readonly submit = vi.fn(async (_text: string): Promise<AnalysisRun> => this.requireRun())
  readonly respondDecision = vi.fn(async (_input: {
    decisionId: string
    optionId?: string | null
    text?: string | null
  }): Promise<AnalysisRun> => this.requireRun())
  readonly cancel = vi.fn(async (): Promise<AnalysisRun> => this.requireRun())
  readonly resume = vi.fn(async (): Promise<AnalysisRun> => this.requireRun())
  readonly setExecutionMode = vi.fn((mode: AgentExecutionMode) => {
    this.current = { ...this.current, executionMode: mode }
    this.events.emit('state', this.snapshot())
  })
  readonly setReasoning = vi.fn((enabled: boolean) => {
    this.current = { ...this.current, reasoning: enabled }
    this.events.emit('state', this.snapshot())
  })
  readonly newConversation = vi.fn(() => {
    this.current = { ...this.current, threadId: null, run: null, items: [], events: [] }
    this.events.emit('state', this.snapshot())
  })
  readonly listThreads = vi.fn(async (): Promise<AgentThreadRecord[]> => (
    this.current.bootstrap?.threads ?? []
  ))
  readonly openThread = vi.fn(async (threadId: string): Promise<void> => {
    this.current = { ...this.current, threadId }
    this.events.emit('state', this.snapshot())
  })

  constructor(current: LocalAgentSessionSnapshot) {
    this.current = current
  }

  snapshot(): LocalAgentSessionSnapshot {
    return {
      ...this.current,
      items: [...this.current.items],
      events: [...this.current.events],
    }
  }

  subscribe(listener: (value: LocalAgentSessionSnapshot) => void): () => void {
    this.events.on('state', listener)
    return () => this.events.off('state', listener)
  }

  private requireRun(): AnalysisRun {
    if (!this.current.run) throw new Error('测试运行不存在。')
    return this.current.run
  }
}

class TestMouseSource implements TerminalMouseSource {
  readonly enabled = true
  private readonly events = new EventEmitter()

  subscribe(listener: (event: TerminalMouseEvent) => void): () => void {
    this.events.on('mouse', listener)
    return () => this.events.off('mouse', listener)
  }

  click(column: number, row: number): void {
    this.events.emit('mouse', mouseEvent('press', column, row))
    this.events.emit('mouse', mouseEvent('release', column, row))
  }
}

function renderConsole(session: LocalAgentConsoleSession, mouse?: TerminalMouseSource) {
  return render(
    <ThemeProvider theme={platformConsoleTheme}>
      <LocalAgentConsoleApp session={session} identity={identity} {...(mouse ? { mouse } : {})} />
    </ThemeProvider>,
  )
}

function snapshot(currentRun: AnalysisRun | null = null): LocalAgentSessionSnapshot {
  return {
    connection: 'online',
    connectionMessage: '已连接',
    bootstrap: null,
    provider: {
      provider: 'deepseek',
      displayName: 'DeepSeek',
      configured: true,
      defaultModel: 'deepseek-v4-flash',
      availableModels: ['deepseek-v4-flash'],
      models: [{
        modelId: 'deepseek-v4-flash',
        contextWindowTokens: 1_000_000,
        capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
        modalities: ['text'],
      }],
      capabilities: ['agents_sdk_live_supervisor'],
      agentRuntime: {
        transport: 'deepseek_responses',
        structuredOutput: 'json_schema',
        functionTools: true,
        deferredTools: false,
        toolNamespaces: false,
        localMcp: true,
        hostedTools: false,
        handoffs: true,
        multiToolResponse: true,
        providerParallelToolControl: false,
        remoteConversation: false,
        serverCompaction: false,
      },
      contextWindowTokens: 1_000_000,
    },
    model: 'deepseek-v4-flash',
    executionMode: 'auto',
    reasoning: true,
    threadId: currentRun?.threadId ?? null,
    run: currentRun,
    items: [],
    events: [],
    error: null,
  }
}

function bootstrapWithWeatherTool() {
  return workspaceBootstrapSnapshotSchema.parse({
    auth: {
      user: {
        userId: 'platform_local_agent',
        subject: 'auth_local_agent',
        email: 'agent@local-agent.geo-agent-platform.invalid',
        displayName: 'Platform Local Agent',
        status: 'active',
        lastLoginAt: null,
        createdAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z',
      },
      defaultWorkspace: null,
      memberships: [],
      platformRoles: ['platform_admin'],
      csrfToken: 'csrf',
      permissions: [],
    },
    session: {
      id: 'session_1',
      workspaceId: 'workspace_1',
      createdByUserId: 'platform_local_agent',
      visibility: 'private',
      createdAt: '2026-07-27T00:00:00.000Z',
      status: 'active',
    },
    threads: [],
    providers: [],
    tools: [{
      name: 'query_public_weather',
      label: '查询公开天气',
      description: '查询公开天气资料。',
      group: 'weather',
      toolKind: 'registry',
      providerId: 'public-weather',
      language: 'typescript',
      isReadOnly: true,
      isDestructive: false,
      parallelSafe: true,
      available: true,
      tags: ['weather'],
      parameters: [],
      error: null,
      meta: {},
    }],
  })
}

function toolConversationItems() {
  return [
    conversationItemSchema.parse({
      itemId: 'tool_output',
      itemType: 'function_call_output',
      runId: 'run_1',
      threadId: 'thread_1',
      callId: 'call_weather',
      output: '{"summary":"杭州午后有阵雨。"}',
      status: 'completed',
      timestamp: '2026-07-27T00:00:02.000Z',
    }),
    conversationItemSchema.parse({
      itemId: 'tool_call',
      itemType: 'function_call',
      runId: 'run_1',
      threadId: 'thread_1',
      callId: 'call_weather',
      name: 'query_public_weather',
      arguments: '{"location":"杭州"}',
      status: 'completed',
      timestamp: '2026-07-27T00:00:01.000Z',
    }),
  ]
}

function toolPair(callId: string, name: string, summary: string, second: number) {
  return [
    conversationItemSchema.parse({
      itemId: `tool_call_${callId}`,
      itemType: 'function_call',
      runId: 'run_1',
      threadId: 'thread_1',
      callId: `call_${callId}`,
      name,
      arguments: '{}',
      status: 'completed',
      timestamp: `2026-07-27T00:00:${String(second).padStart(2, '0')}.000Z`,
    }),
    conversationItemSchema.parse({
      itemId: `tool_output_${callId}`,
      itemType: 'function_call_output',
      runId: 'run_1',
      threadId: 'thread_1',
      callId: `call_${callId}`,
      output: JSON.stringify({ summary }),
      status: 'completed',
      timestamp: `2026-07-27T00:00:${String(second + 1).padStart(2, '0')}.000Z`,
    }),
  ]
}

function threadRecord(id: string, title: string, latestUserQuery: string): AgentThreadRecord {
  return {
    id,
    sessionId: 'session_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'platform_local_agent',
    visibility: 'private',
    title,
    status: 'active',
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    latestRunId: null,
    latestUserQuery,
    latestAssistantSummary: null,
    latestRunStatus: 'completed',
    latestArtifactId: null,
    latestArtifactName: null,
    historyPreview: latestUserQuery,
    runCount: 1,
    conversationPath: null,
  }
}

function run(status: AnalysisRun['status'], decisions: DecisionRequest[] = []): AnalysisRun {
  return analysisRunSchema.parse({
    id: 'run_1',
    threadId: 'thread_1',
    sessionId: 'session_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'platform_local_agent',
    visibility: 'private',
    userQuery: '杭州明天会下雨吗？',
    modelProvider: 'deepseek',
    modelName: 'deepseek-v4-flash',
    status,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    state: {
      sessionId: 'session_1',
      threadId: 'thread_1',
      userQuery: '杭州明天会下雨吗？',
      decisions,
    },
  })
}

function approvalDecision(): DecisionRequest {
  return {
    decisionId: 'approval_1',
    kind: 'approval',
    title: '执行受保护工具',
    question: '是否允许写入运行结果？',
    description: '',
    options: [{
      optionId: 'approve',
      label: '批准',
      description: '',
      kind: 'approval',
      reason: null,
      payload: { approved: true },
    }, {
      optionId: 'reject',
      label: '拒绝',
      description: '',
      kind: 'approval',
      reason: null,
      payload: { approved: false },
    }],
    allowFreeText: false,
    status: 'pending',
    payload: {},
    createdAt: '2026-07-27T00:00:00.000Z',
    resolvedAt: null,
  }
}

function clarificationDecision(optionCount: number): DecisionRequest {
  return {
    decisionId: 'clarification_many',
    kind: 'clarification',
    title: '请选择一个处理范围',
    question: '本次分析应使用哪个范围？',
    description: '',
    options: Array.from({ length: optionCount }, (_, index) => ({
      optionId: `option_${index + 1}`,
      label: `决策选项 ${String(index + 1).padStart(2, '0')}`,
      description: `选项说明 ${index + 1}`,
      kind: 'generic',
      reason: null,
      payload: {},
    })),
    allowFreeText: true,
    status: 'pending',
    payload: {},
    createdAt: '2026-07-27T00:00:00.000Z',
    resolvedAt: null,
  }
}

function resize(stdout: EventEmitter, columns: number, rows: number): void {
  Object.defineProperty(stdout, 'columns', { configurable: true, value: columns })
  Object.defineProperty(stdout, 'rows', { configurable: true, value: rows })
  stdout.emit('resize')
}

function assertFrameFits(frame: string, columns: number, rows: number): void {
  const lines = frame.split('\n')
  expect(lines.length).toBeLessThanOrEqual(rows)
  for (const line of lines) {
    expect(stringWidth(stripVTControlCharacters(line)), line).toBeLessThanOrEqual(columns)
  }
}

function mouseEvent(kind: TerminalMouseEvent['kind'], column: number, row: number): TerminalMouseEvent {
  return { kind, column, row, button: 'left', deltaY: 0, shift: false, meta: false, ctrl: false }
}

const identity: LocalAgentConsoleIdentity = {
  version: '0.1.0',
  projectRoot: path.join(os.tmpdir(), 'geo-agent-platform-console-fixture'),
  osUser: 'James',
  hostname: '杭州开发机',
  keyVersion: 'v1',
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台进度卡规则测试
//
//   文件:       workbenchProgressCard.test.ts
//
//   日期:       2026年07月01日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { requiredAt } from './testSupport'
import { deriveWorkbenchProgressSummary } from '../app/layout/WorkbenchProgressModel'
import { buildProgressItems } from '../app/derivedState'
import type { RunEvent } from '@geo-agent-platform/shared-types'

const progressItems = [
  { id: 'understand', title: '理解需求', description: '正在理解问题', status: 'done' as const },
  { id: 'data', title: '准备数据', description: '正在准备数据', status: 'active' as const },
  { id: 'deliver', title: '交付结果', description: '等待交付结果', status: 'pending' as const },
]

describe('workbench progress card model', () => {
  it('shows idle copy before any run starts', () => {
    // 进度卡不能再用装饰圆点兜底；没有运行时必须明确说明等待用户输入。
    const summary = deriveWorkbenchProgressSummary({ progressItems: [], tasks: [], events: [] })

    expect(summary.statusLabel).toBe('等待输入')
    expect(summary.description).toContain('提交问题后')
    expect(summary.latestDetail).toBe('暂无运行任务')
  })

  it('derives running status from active progress and task facts', () => {
    const summary = deriveWorkbenchProgressSummary({
      runStatus: 'running',
      progressItems,
      tasks: [{ id: 'task_1', content: '准备 NetCDF 元数据', activeForm: '正在读取 NetCDF 元数据', status: 'running' }],
      events: [],
    })

    expect(summary.statusLabel).toBe('正在分析')
    expect(summary.description).toBe('正在准备数据')
    expect(summary.latestDetail).toBe('正在读取 NetCDF 元数据')
    expect(summary.completedCount).toBe(1)
  })

  it('marks completed runs with delivery copy and full completion count', () => {
    const summary = deriveWorkbenchProgressSummary({
      runStatus: 'completed',
      progressItems,
      tasks: [{ id: 'task_2', content: '已生成气象分析摘要', activeForm: '生成摘要', status: 'completed' }],
      events: [],
      artifactCount: 1,
    })

    expect(summary.statusLabel).toBe('分析完成')
    expect(summary.tone).toBe('done')
    expect(summary.completedCount).toBe(summary.totalCount)
    expect(summary.latestDetail).toBe('已生成气象分析摘要')
  })

  it('describes a text-only completion without claiming result artifacts exist', () => {
    const items = buildProgressItems({ runStatus: 'completed', artifacts: [], events: [] })
    const summary = deriveWorkbenchProgressSummary({
      runStatus: 'completed',
      progressItems: items,
      tasks: [],
      events: [],
      artifactCount: 0,
    })

    expect(summary.statusLabel).toBe('回答完成')
    expect(summary.description).toContain('没有生成地图、文件或下载产物')
    expect(summary.latestDetail).toBe('回答已经整理完成')
    expect(items.find(item => item.id === 'deliver')?.description).toContain('没有生成地图、文件或下载产物')
  })

  it('keeps completed tool work visible when no artifact was generated', () => {
    const events = [
      {
        eventId: 'event_tool_started',
        runId: 'run_weather',
        threadId: 'thread_weather',
        type: 'tool.started',
        message: '查询公开天气',
        timestamp: '2026-07-23T00:00:00.000Z',
        payload: { tool: 'query_public_weather' },
      },
      {
        eventId: 'event_tool_completed',
        runId: 'run_weather',
        threadId: 'thread_weather',
        type: 'tool.completed',
        message: 'Open-Meteo 公开天气已返回：北京当前阴，22.7°C。',
        timestamp: '2026-07-23T00:00:01.000Z',
        payload: { tool: 'query_public_weather' },
      },
      {
        eventId: 'event_run_completed',
        runId: 'run_weather',
        threadId: 'thread_weather',
        type: 'run.completed',
        message: '运行完成',
        timestamp: '2026-07-23T00:00:02.000Z',
        payload: {},
      },
    ] satisfies RunEvent[]

    const items = buildProgressItems({ runStatus: 'completed', artifacts: [], events })

    expect(items.find(item => item.id === 'understand')).toMatchObject({
      status: 'done',
      description: '已理解本轮问题，并据此完成后续处理。',
    })
    expect(items.find(item => item.id === 'prepare')?.description).toBe('已通过业务工具取得本轮所需数据。')
    expect(items.find(item => item.id === 'analyze')?.description).toContain('Open-Meteo 公开天气已返回')
    expect(items.find(item => item.id === 'deliver')?.description).toContain('工具结果已整理为回答')
    expect(items.map(item => item.description).join('\n')).not.toContain('本轮不需要')
  })

  it('surfaces failed runs as warnings with a concrete latest detail', () => {
    const summary = deriveWorkbenchProgressSummary({
      runStatus: 'failed',
      progressItems: [
        requiredAt(progressItems, 0, '进度条目'),
        { id: 'data', title: '准备数据', description: '数据读取失败', status: 'warning' as const },
      ],
      tasks: [],
      events: [{ type: 'run.failed', message: 'NetCDF 文件不可读' } as never],
    })

    expect(summary.statusLabel).toBe('分析失败')
    expect(summary.tone).toBe('warning')
    expect(summary.description).toBe('数据读取失败')
    expect(summary.latestDetail).toBe('分析没有顺利完成，请稍后重试。')
  })

  it('keeps local SDK trace records out of user-facing latest progress copy', () => {
    const events = [
      {
        eventId: 'event_work',
        runId: 'run_1',
        threadId: 'thread_1',
        type: 'step.started',
        message: '正在检查数据范围',
        timestamp: '2026-07-21T00:00:00.000Z',
        payload: {},
      },
      {
        eventId: 'event_trace',
        runId: 'run_1',
        threadId: 'thread_1',
        type: 'trace.recorded',
        message: 'SDK 模型 Span完成',
        timestamp: '2026-07-21T00:00:00.100Z',
        payload: { diagnostic: true },
      },
    ] satisfies RunEvent[]
    const summary = deriveWorkbenchProgressSummary({
      runStatus: 'running',
      progressItems,
      tasks: [],
      events,
    })

    expect(summary.latestDetail).toBe('正在检查数据范围')
  })
})

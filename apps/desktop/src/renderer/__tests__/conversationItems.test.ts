// +-------------------------------------------------------------------------
//
//   地理智能平台 - ConversationItem 投影测试
//
//   文件:       conversationItems.test.ts
//
//   日期:       2026年06月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 测试聊天 UI 的唯一事实源：ConversationItem。
// 这里不构造 RunEvent 或旧 message frame，防止诊断流重新进入聊天主路径。

import { describe, expect, it } from 'vitest'
import type { ConversationItem } from '@geo-agent-platform/shared-types'
import { deriveEntriesFromItems, pickConversationHeadline } from '@geo-agent-platform/conversation-presentation'

describe('deriveEntriesFromItems', () => {
  it('按 item 顺序渲染 user、reasoning 和 assistant message', () => {
    const entries = deriveEntriesFromItems([
      item({ itemId: 'user:run1', itemType: 'message', role: 'user', body: '查询杭州天气' }),
      item({ itemId: 'reasoning:run1', itemType: 'reasoning', body: '先检查数据。', status: 'running' }),
      item({ itemId: 'assistant:run1', itemType: 'message', role: 'assistant', body: '杭州今天有雨。' }),
    ])

    expect(entries.map((entry) => entry.title)).toEqual(['用户', '思考', '回答'])
    expect(entries.at(1)?.status).toBe('running')
    expect(entries.at(2)?.body).toBe('杭州今天有雨。')
  })

  it('按 callId 配对工具调用和工具输出', () => {
    const entries = deriveEntriesFromItems([
      item({
        itemId: 'toolcall:run1:call1',
        itemType: 'function_call',
        callId: 'call1',
        name: 'geocode_place',
        arguments: '{"query":"杭州"}',
        status: 'running',
      }),
      item({
        itemId: 'toolout:run1:call1',
        itemType: 'function_call_output',
        callId: 'call1',
        output: '已解析杭州。',
        metadata: { resultId: 'res_1', artifactId: 'artifact_1' },
      }),
    ], 'completed', [
      {
        name: 'geocode_place',
        label: '地点解析',
        description: '',
        group: 'geo',
        toolKind: 'registry',
        providerId: 'geocode',
        language: 'typescript',
        isReadOnly: true,
        isDestructive: false,
        parallelSafe: false,
        available: true,
        tags: [],
        parameters: [],
        error: null,
        meta: {},
      },
    ])

    expect(entries).toHaveLength(1)
    expect(entries.at(0)?.kind).toBe('command_batch')
    expect(entries.at(0)?.title).toBe('地点解析')
    expect(entries.at(0)?.status).toBe('completed')
    expect(entries.at(0)?.artifactId).toBe('artifact_1')
    expect(entries.at(0)?.commands?.at(0)?.details?.args).toEqual({ query: '杭州' })
    expect(entries.at(0)?.commands?.at(0)?.details?.resultId).toBe('res_1')
  })

  it('优先使用运行记录持久化的中文工具名称', () => {
    const entries = deriveEntriesFromItems([
      item({
        itemId: 'toolcall:run1:call1',
        itemType: 'function_call',
        callId: 'call1',
        name: 'meteorological_inspect',
        arguments: '{}',
        metadata: { toolLabel: '检查气象数据集' },
      }),
    ])

    expect(entries.at(0)?.title).toBe('检查气象数据集')
  })

  it('未知工具不向用户泄露机器名称', () => {
    const entries = deriveEntriesFromItems([
      item({
        itemId: 'toolcall:run1:call1',
        itemType: 'function_call',
        callId: 'call1',
        name: 'unknown_machine_tool',
        arguments: '{}',
      }),
    ])

    expect(entries.at(0)?.title).toBe('工具调用')
    expect(entries.at(0)?.title).not.toContain('unknown_machine_tool')
  })

  it('优先使用运行记录持久化的中文工具名', () => {
    const entries = deriveEntriesFromItems([
      item({
        itemId: 'toolcall:run1:call1',
        itemType: 'function_call',
        callId: 'call1',
        name: 'meteorological_inspect',
        metadata: { toolLabel: '检查气象数据集' },
      }),
    ])

    expect(entries.at(0)?.title).toBe('检查气象数据集')
  })

  it('未知外部工具不向普通用户暴露机器标识', () => {
    const entries = deriveEntriesFromItems([
      item({
        itemId: 'toolcall:run1:call1',
        itemType: 'function_call',
        callId: 'call1',
        name: 'foreign_internal_tool_name',
      }),
    ])

    expect(entries.at(0)?.title).toBe('工具调用')
    expect(entries.at(0)?.title).not.toContain('foreign_internal_tool_name')
  })

  it('把短时临近预报（短临）回答工具的结构化输出投影成标准纯文本', () => {
    const entries = deriveEntriesFromItems([
      item({ itemId: 'call', itemType: 'function_call', callId: 'call1', name: 'answer_nowcast_question', arguments: '{}' }),
      item({
        itemId: 'output',
        itemType: 'function_call_output',
        callId: 'call1',
        name: 'answer_nowcast_question',
        output: '{"answer":"未来3小时不会下雨，您可以放心出门。","basis":[]}',
      }),
    ])

    expect(entries).toHaveLength(1)
    expect(entries.at(0)?.body).toBe('未来3小时不会下雨，您可以放心出门。')
    expect(entries.at(0)?.commands?.at(0)?.body).toBe('未来3小时不会下雨，您可以放心出门。')
  })

  it('不会把工具 envelope 的执行消息当成短临回答正文', () => {
    const entries = deriveEntriesFromItems([
      item({ itemId: 'call', itemType: 'function_call', callId: 'call1', name: 'answer_nowcast_question', arguments: '{}' }),
      item({
        itemId: 'output',
        itemType: 'function_call_output',
        callId: 'call1',
        name: 'answer_nowcast_question',
        output: '{"message":"answer_nowcast_question 执行完成","payload":{"answer":"5分钟后将下中雨，未来3小时持续下雨。"}}',
      }),
    ])

    expect(entries).toHaveLength(1)
    expect(entries.at(0)?.body).toBe('5分钟后将下中雨，未来3小时持续下雨。')
    expect(entries.at(0)?.body).not.toContain('answer_nowcast_question')
    expect(entries.at(0)?.commands?.at(0)?.body).toBe('5分钟后将下中雨，未来3小时持续下雨。')
  })

  it('工具调用失败且没有输出条目时显示真实失败原因', () => {
    const entries = deriveEntriesFromItems([
      item({
        itemId: 'call:failed',
        itemType: 'function_call',
        callId: 'call_failed',
        name: 'geocode_place',
        arguments: '{"query":"杭州西湖"}',
        body: '地点地理编码服务未配置。',
        status: 'failed',
        isError: true,
      }),
    ])

    expect(entries.at(0)).toMatchObject({
      status: 'failed',
      body: '地点地理编码服务未配置。',
    })
    expect(entries.at(0)?.commands?.at(0)?.body).toBe('地点地理编码服务未配置。')
  })

  it('把工具调用前的普通 assistant 文本显示为过程说明而不是思考过程', () => {
    const entries = deriveEntriesFromItems([
      item({
        itemId: 'assistant:preamble',
        itemType: 'message',
        role: 'assistant',
        body: '我先检查一下已上传的数据。',
        metadata: { messageKind: 'commentary' },
      }),
      item({ itemId: 'reasoning:run1', itemType: 'reasoning', body: '内部推理片段。' }),
    ])

    expect(entries.at(0)).toMatchObject({
      kind: 'message',
      role: 'assistant',
      title: '过程说明',
      body: '我先检查一下已上传的数据。',
      badge: 'commentary',
    })
    expect(entries.at(1)).toMatchObject({
      title: '思考',
      body: '内部推理片段。',
      badge: 'thinking',
    })
  })

  it('直接显示供应商返回的原始思考内容', () => {
    const entries = deriveEntriesFromItems([
      item({
        itemId: 'reasoning:provider',
        itemType: 'reasoning',
        body: 'I should inspect the available weather data first.',
      }),
    ])

    expect(entries.at(0)).toMatchObject({
      title: '思考',
      body: 'I should inspect the available weather data first.',
    })
  })

  it('不把成功 terminal result 重复渲染为最终回答', () => {
    const entries = deriveEntriesFromItems([
      item({ itemId: 'assistant:run1', itemType: 'message', role: 'assistant', body: '最终回答。' }),
      item({ itemId: 'result:run1:success', itemType: 'result', body: null, metadata: { resultType: 'success' } }),
    ])

    expect(entries).toHaveLength(1)
    expect(entries.at(0)?.body).toBe('最终回答。')
  })

  it('把 failed terminal result 渲染为错误条目', () => {
    const entries = deriveEntriesFromItems([
      item({ itemId: 'result:run1:failed', itemType: 'result', body: '', metadata: { resultType: 'failed', errors: ['工具失败'] } }),
    ])

    expect(entries).toHaveLength(1)
    expect(entries.at(0)?.kind).toBe('error')
    expect(entries.at(0)?.status).toBe('failed')
    expect(entries.at(0)?.body).toBe('工具失败')
  })

  it('把等待审批的 plan result 投影为可操作审批条目', () => {
    const plan = {
      goal: '生成短时强降水风险区划图',
      steps: [{ id: 'step_1', tool: 'render_rainfall_risk_map', args: {}, reason: '生成风险图' }],
    }
    const entries = deriveEntriesFromItems([
      item({
        itemId: 'result:approval',
        itemType: 'result',
        metadata: {
          resultType: 'waiting_approval',
          approvalId: 'approval_1',
          title: '接受这个执行计划？',
          description: '批准后继续执行。',
          args: { plan },
        },
      }),
    ])

    expect(entries).toHaveLength(1)
    expect(entries.at(0)).toMatchObject({
      kind: 'approval',
      approvalId: 'approval_1',
      title: '接受这个执行计划？',
      status: 'blocked',
    })
    expect(entries.at(0)?.details?.args).toEqual({ plan })
  })

  it('把旧运行里的 terminated 显示为可恢复的模型连接错误', () => {
    const entries = deriveEntriesFromItems([
      item({ itemId: 'result:run1:failed', itemType: 'result', body: '', metadata: { resultType: 'failed', message: 'terminated' } }),
    ])

    expect(entries.at(0)?.body).toContain('模型连接被上游中断')
  })
})

describe('pickConversationHeadline', () => {
  it('从最新 message 或 command 中取标题', () => {
    const headline = pickConversationHeadline([
      item({ itemId: 'user:run1', itemType: 'message', role: 'user', body: '查询杭州天气' }),
      item({ itemId: 'assistant:run1', itemType: 'message', role: 'assistant', body: '杭州今天有雨。' }),
    ], 'completed')

    expect(headline.title).toBe('回答')
    expect(headline.body).toBe('杭州今天有雨。')
  })
})

function item(overrides: Partial<ConversationItem>): ConversationItem {
  return {
    itemId: overrides.itemId ?? 'item:run1',
    itemType: overrides.itemType ?? 'message',
    runId: overrides.runId ?? 'run1',
    threadId: overrides.threadId ?? 'thread1',
    turnId: overrides.turnId ?? 'run1',
    callId: overrides.callId ?? null,
    role: overrides.role ?? null,
    body: overrides.body ?? null,
    name: overrides.name ?? null,
    arguments: overrides.arguments ?? null,
    output: overrides.output ?? null,
    isError: overrides.isError ?? false,
    phase: overrides.phase ?? null,
    status: overrides.status ?? 'completed',
    metadata: overrides.metadata ?? {},
    timestamp: overrides.timestamp ?? '2026-06-04T00:00:00Z',
  }
}

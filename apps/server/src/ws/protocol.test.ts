// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 协议单元测试
//
//   文件:       protocol.test.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { failure, parseMessage, push, success } from './protocol.js'

describe('WebSocket control protocol', () => {
  it('correlates response envelopes with request IDs', () => {
    const message = parseMessage(JSON.stringify({ type: 'run:get', id: 'req_7', payload: { runId: 'run_1' } }))
    expect(message.id).toBe('req_7')
    expect(JSON.parse(success(message.id, { ok: 1 }))).toMatchObject({
      type: 'response', id: 'req_7', payload: { ok: true, data: { ok: 1 } },
    })
  })

  it('accepts workspace bootstrap and paged run list commands', () => {
    expect(parseMessage(JSON.stringify({ type: 'workspace:bootstrap', id: 'boot', payload: {} })).type)
      .toBe('workspace:bootstrap')
    expect(parseMessage(JSON.stringify({
      type: 'run:list', id: 'runs', payload: { sessionId: 'session_1', limit: 20 },
    })).type).toBe('run:list')
    expect(parseMessage(JSON.stringify({
      type: 'run:respond-decision', id: 'decision', payload: { runId: 'run_1', decisionId: 'decision_1', optionId: 'approve' },
    })).type).toBe('run:respond-decision')
    expect(parseMessage(JSON.stringify({ type: 'speech:authorization', id: 'speech', payload: {} })).type)
      .toBe('speech:authorization')
  })

  it('在进入 Server 注册表前按共享命令契约拒绝无效 payload', () => {
    expect(() => parseMessage(JSON.stringify({
      type: 'run:get',
      id: 'bad_run',
      payload: { runId: '' },
    }))).toThrow()
    expect(() => parseMessage(JSON.stringify({
      type: 'subagent:cancel',
      id: 'bad_extra',
      payload: { runId: 'run_1', agentId: 'agent_1', cancellationId: 'cancel_1', extra: true },
    }))).toThrow()
  })

  it('returns explicit errors and schema-checked uncorrelated pushes', () => {
    expect(JSON.parse(failure('req_8', 'not_found', '不存在'))).toMatchObject({
      id: 'req_8', payload: { ok: false, error: { code: 'not_found', message: '不存在' } },
    })
    expect(JSON.parse(push('keepalive', {}))).toMatchObject({
      type: 'keepalive', id: null, payload: { data: {} },
    })
  })
})

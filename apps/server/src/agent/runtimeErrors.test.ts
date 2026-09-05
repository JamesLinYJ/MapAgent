// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 稳定错误映射测试
//
//   文件:       runtimeErrors.test.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  MaxTurnsExceededError,
  ModelBehaviorError,
  UserError,
} from '@openai/agents'
import { describe, expect, it } from 'vitest'
import { runtimeFailure, runtimeFailureMessage } from './runtimeErrors.js'

describe('runtimeFailureMessage', () => {
  it('does not expose English SDK internals or mislabel every UserError as a DeepSeek error', () => {
    expect(runtimeFailureMessage(new UserError('serialized state is incompatible'))).toBe(
      'Agents SDK 拒绝了当前运行配置或恢复状态；请查看服务端日志。',
    )
  })

  it('preserves stable Chinese boundary errors', () => {
    expect(runtimeFailureMessage(new UserError('当前 Sandbox backend 与检查点不一致。'))).toBe(
      '当前 Sandbox backend 与检查点不一致。',
    )
  })

  it('maps SDK control errors to stable Chinese messages', () => {
    expect(runtimeFailureMessage(new MaxTurnsExceededError('limit'))).toContain('最大运行轮次')
    expect(runtimeFailureMessage(new ModelBehaviorError('bad output'))).toContain('不符合 Agent 协议')
  })

  it('classifies model, database, data and transport failures without using the selected provider as evidence', () => {
    expect(runtimeFailure(new Error('DeepSeek JSON Output 未返回单个合法 JSON object。'))).toMatchObject({
      source: 'model',
    })
    expect(runtimeFailure(Object.assign(
      new Error('函数 geo_agent_platform_layer_tiles 不存在'),
      { code: '42883' },
    ))).toMatchObject({
      source: 'database',
      code: '42883',
    })
    expect(runtimeFailure(
      new Error('短时临近预报序列至少需要两个气象文件'),
      { failedTool: 'create_nowcast_sequence' },
    )).toMatchObject({
      source: 'data',
    })
    expect(runtimeFailure(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))).toMatchObject({
      source: 'transport',
      retryable: true,
    })
    expect(runtimeFailure(new Error('内部状态不一致'))).toMatchObject({
      source: 'platform',
    })
  })

  it('honors typed boundary failures before message heuristics', () => {
    const error = Object.assign(new Error('当前对话没有足够输入。'), {
      failureSource: 'data',
      code: 'automation_input_requirement_failed',
    })

    expect(runtimeFailure(error)).toEqual({
      source: 'data',
      code: 'automation_input_requirement_failed',
      message: '当前对话没有足够输入。',
      retryable: false,
    })
  })
})

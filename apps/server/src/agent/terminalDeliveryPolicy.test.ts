// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 终态交付证据策略测试
//
//   文件:       terminalDeliveryPolicy.test.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { evaluateTerminalDelivery } from './terminalDeliveryPolicy.js'

const completeDelivery = {
  markdown: '北京当前 22.7°C，未来三小时降水概率不超过 8%。数据源：Open-Meteo。',
  summary: '北京当前天气及短时降水概率已给出。',
  artifactIds: [],
  warnings: [],
}

describe('evaluateTerminalDelivery', () => {
  it('rejects a preparation sentence presented as a completed answer', () => {
    const decision = evaluateTerminalDelivery({
      delivery: {
        ...completeDelivery,
        markdown: '## 查询西湖位置\n我先查询西湖的精确位置，以便获取准确预报。',
        summary: '我先查询西湖位置。',
      },
    })

    expect(decision).toMatchObject({ accepted: false, code: 'preparation_only' })
    if (!decision.accepted) expect(decision.repairInstruction).toContain('不能展示给用户')
  })

  it('does not bind the generic runtime to a weather provider or tool name', () => {
    expect(evaluateTerminalDelivery({
      delivery: {
        ...completeDelivery,
        markdown: '杭州短时强降水风险主要集中在西湖区，科学计算结果和风险图已生成。',
      },
    })).toEqual({ accepted: true })
  })

  it('does not require a live tool for timeless explanatory questions', () => {
    expect(evaluateTerminalDelivery({
      delivery: {
        ...completeDelivery,
        markdown: '降水概率表示指定时间和区域内出现可测降水的可能性。',
      },
    })).toEqual({ accepted: true })
  })

  it('does not reject a substantive answer merely because it begins with 我先说明', () => {
    expect(evaluateTerminalDelivery({
      delivery: {
        ...completeDelivery,
        markdown: '我先说明结论：3 个站点均未超过阈值。结果表明当前不需要触发预警，建议继续每小时复核。',
      },
    })).toEqual({ accepted: true })
  })
})

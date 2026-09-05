// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 终态交付证据策略
//
//   文件:       terminalDeliveryPolicy.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { SupervisorDelivery } from '@geo-agent-platform/shared-types/runtime'

export interface TerminalDeliveryEvidence {
  delivery: SupervisorDelivery
}

export type TerminalDeliveryDecision =
  | { accepted: true }
  | {
      accepted: false
      code: 'preparation_only'
      reason: string
      repairInstruction: string
    }

const PREPARATION_ACTION = /(?:我先|我会|我将|接下来|下一步|让我|准备|正在).{0,24}(?:查询|检查|调用|获取|分析|处理|定位|整理)/iu
const CONCRETE_RESULT = /\d|结论|结果|建议|数据来源|未找到|无法|不能|不需要|已完成/iu

/**
 * 终态必须是已经完成的可核验回答，而不是“稍后去做”的前置说明。
 * 供应商或领域专属证据策略不属于通用运行时；应由 ToolProvider 的契约、
 * 提示和结果 schema 负责，避免核心编排绑定具体工具名或数据供应商。
 */
export function evaluateTerminalDelivery(evidence: TerminalDeliveryEvidence): TerminalDeliveryDecision {
  const text = `${evidence.delivery.markdown}\n${evidence.delivery.summary}`.trim()
  if (PREPARATION_ACTION.test(text) && (text.length < 180 || !CONCRETE_RESULT.test(text))) {
    return {
      accepted: false,
      code: 'preparation_only',
      reason: '上一版交付只有准备执行的说明，没有给出已经完成的结果。',
      repairInstruction: terminalRepairInstruction('请立即执行所需工具；不要再次用“我先查询”“接下来处理”等计划语气结束。'),
    }
  }

  return { accepted: true }
}

function terminalRepairInstruction(requirement: string): string {
  return [
    '<terminal_delivery_repair>',
    '上一版最终回答未通过终态证据校验，不能展示给用户。',
    requirement,
    '获得结果后直接提交完整的中文 Markdown 正文；若工具失败，明确报告失败，不得把准备动作写成完成结果。',
    '</terminal_delivery_repair>',
  ].join('\n')
}

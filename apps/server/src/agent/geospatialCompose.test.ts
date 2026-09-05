// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地理分析 Compose 运行契约测试
//
//   文件:       geospatialCompose.test.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import type { ToolDef } from '../framework/types.js'
import type { ToolRegistry } from '../framework/registry.js'
import {
  buildGeospatialComposePrompt,
  validateGeospatialComposeWorkflowDraft,
} from './geospatialCompose.js'

describe('geospatial compose contract', () => {
  it('accepts a dependency-linked discovery, validation, analysis and verification chain', () => {
    expect(validateGeospatialComposeWorkflowDraft(validWorkflow(), registry(), [])).toBeNull()
  })

  it('rejects a compose workflow that omits an evidence phase', () => {
    const input = validWorkflow()
    const workflow = input.workflow as { steps: Array<Record<string, unknown>> }
    workflow.steps = workflow.steps.filter(step => step.phase !== 'verify')

    expect(validateGeospatialComposeWorkflowDraft(input, registry(), []))
      .toBe("地理分析 Compose 工作流无效：缺少 'verify' 阶段。")
  })

  it('rejects side effects in discovery, validation and verification phases', () => {
    const input = validWorkflow()
    const workflow = input.workflow as { steps: Array<Record<string, unknown>> }
    const validation = workflow.steps.find(step => step.phase === 'validate')
    if (!validation) throw new Error('测试工作流缺少 validate 步骤')
    validation.toolName = 'update_layer'

    expect(validateGeospatialComposeWorkflowDraft(input, registry(), []))
      .toContain('validate 阶段步骤“核验数据”必须使用可核验的无副作用读取能力')
  })

  it('rejects phase labels that do not form the required dependency chain', () => {
    const input = validWorkflow()
    const workflow = input.workflow as { steps: Array<Record<string, unknown>> }
    const verification = workflow.steps.find(step => step.phase === 'verify')
    if (!verification) throw new Error('测试工作流缺少 verify 步骤')
    verification.dependsOn = ['discover']

    expect(validateGeospatialComposeWorkflowDraft(input, registry(), []))
      .toBe('地理分析 Compose 工作流无效：至少一个 verify 步骤必须直接或间接依赖 analyze。')
  })

  it('instructs the supervisor to preserve valueRef, approval and hard-failure boundaries', () => {
    const prompt = buildGeospatialComposePrompt()

    expect(prompt).toContain('discover → validate → analyze → verify')
    expect(prompt).toContain('只传 valueRef')
    expect(prompt).toContain('继续遵守自身审批')
    expect(prompt).toContain('不得缩减目标后宣称 Compose 已完成')
  })
})

function validWorkflow(): Record<string, unknown> {
  return {
    workflow: {
      goal: '完成可核验的区域风险分析',
      steps: [
        step('discover', '发现数据', 'list_layers', []),
        step('validate', '核验数据', 'inspect_dataset', ['discover']),
        step('analyze', '执行分析', 'spatial_analysis', ['validate']),
        step('verify', '复核结果', 'verify_analysis', ['analyze']),
      ],
    },
  }
}

function step(
  phase: string,
  title: string,
  toolName: string,
  dependsOn: string[],
): Record<string, unknown> {
  return {
    stepId: phase,
    title,
    kind: 'tool',
    phase,
    toolName,
    ownerAgentId: 'supervisor',
    args: {},
    reason: title,
    dependsOn,
  }
}

function registry(): ToolRegistry {
  const tools = new Map<string, Pick<ToolDef, 'isReadOnly' | 'isDestructive'>>([
    ['list_layers', { isReadOnly: true, isDestructive: false }],
    ['inspect_dataset', { isReadOnly: true, isDestructive: false }],
    ['spatial_analysis', { isReadOnly: true, isDestructive: false }],
    ['verify_analysis', { isReadOnly: true, isDestructive: false }],
    ['update_layer', { isReadOnly: false, isDestructive: true }],
  ])
  return {
    get: (name: string) => tools.get(name) as ToolDef | undefined,
  } as ToolRegistry
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 智能体工作流状态机测试
//
//   文件:       agentWorkflowState.test.ts
//
//   日期:       2026年07月17日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import {
  advanceAgentWorkflowObjectiveRevision,
  completeAgentWorkflowStep,
  createAgentWorkflow,
  failAgentWorkflowStep,
  findRunnableAgentWorkflowStep,
  reviseAgentWorkflow,
  startAgentWorkflowStep,
} from './agentWorkflowState.js'

describe('agentWorkflowState', () => {
  it('validates dependency ownership and rejects cycles', () => {
    expect(() => createAgentWorkflow({
      goal: '生成分析结果',
      steps: [step('a', 'tool_a', ['missing'])],
    })).toThrow("依赖不存在的步骤 'missing'")

    expect(() => createAgentWorkflow({
      goal: '生成分析结果',
      steps: [step('a', 'tool_a', ['b']), step('b', 'tool_b', ['a'])],
    })).toThrow('循环依赖')
  })

  it('exposes independent steps concurrently and gates dependent steps', () => {
    const workflow = createAgentWorkflow({
      goal: '并行准备后汇总',
      steps: [
        step('a', 'tool_a'),
        step('b', 'tool_b'),
        step('c', 'tool_c', ['a', 'b']),
      ],
    })
    expect(findRunnableAgentWorkflowStep(workflow, invocation('tool_a'))?.stepId).toBe('a')
    expect(findRunnableAgentWorkflowStep(workflow, invocation('tool_b'))?.stepId).toBe('b')
    expect(findRunnableAgentWorkflowStep(workflow, invocation('tool_c'))).toBeNull()

    const afterA = completeAgentWorkflowStep(
      startAgentWorkflowStep(workflow, { stepId: 'a' }),
      { stepId: 'a', resultSummary: 'A 完成' },
    )
    expect(findRunnableAgentWorkflowStep(afterA, invocation('tool_c'))).toBeNull()
    const afterB = completeAgentWorkflowStep(
      startAgentWorkflowStep(afterA, { stepId: 'b' }),
      { stepId: 'b', resultSummary: 'B 完成' },
    )
    expect(findRunnableAgentWorkflowStep(afterB, invocation('tool_c'))?.stepId).toBe('c')
  })

  it('matches workflow identity and ownership without treating predicted arguments as authorization', () => {
    const workflow = createAgentWorkflow({
      goal: '按工作流身份执行',
      steps: [{
        ...step('inspect', 'inspect_dataset'),
        args: { datasetId: 'dataset_1', options: { variable: 'QPF' } },
      }, {
        ...step('delegate', 'spatial_analyst', ['inspect']),
        kind: 'agent' as const,
        ownerAgentId: 'spatial_analyst',
      }],
    })

    expect(findRunnableAgentWorkflowStep(workflow, invocation('inspect_dataset'))?.stepId).toBe('inspect')

    const inspected = completeAgentWorkflowStep(
      startAgentWorkflowStep(workflow, { stepId: 'inspect' }),
      { stepId: 'inspect', resultSummary: '完成' },
    )
    expect(findRunnableAgentWorkflowStep(inspected, {
      ...invocation('spatial_analyst'),
      ownerAgentId: 'other_agent',
    })).toBeNull()
    expect(findRunnableAgentWorkflowStep(inspected, {
      ...invocation('spatial_analyst'),
      ownerAgentId: 'spatial_analyst',
    })?.stepId).toBe('delegate')
  })

  it('requires explicit identity for ambiguous same-tool steps and honors reverse execution order', () => {
    const workflow = createAgentWorkflow({
      goal: '分别检查两个数据集',
      steps: [
        step('inspect_a', 'inspect_dataset'),
        step('inspect_b', 'inspect_dataset'),
      ],
    })

    expect(findRunnableAgentWorkflowStep(workflow, invocation('inspect_dataset'))).toBeNull()
    expect(findRunnableAgentWorkflowStep(workflow, {
      ...invocation('inspect_dataset'),
      workflowStepId: 'inspect_b',
    })?.stepId).toBe('inspect_b')
    expect(findRunnableAgentWorkflowStep(workflow, {
      ...invocation('inspect_dataset'),
      workflowStepId: 'missing',
    })).toBeNull()
  })

  it('binds repeated same-tool steps across dependency boundaries', () => {
    const workflow = createAgentWorkflow({
      goal: '依次检查同一数据集',
      steps: [
        step('inspect_first', 'inspect_dataset'),
        step('inspect_second', 'inspect_dataset', ['inspect_first']),
      ],
    })

    expect(findRunnableAgentWorkflowStep(workflow, invocation('inspect_dataset'))?.stepId)
      .toBe('inspect_first')
    const afterFirst = completeAgentWorkflowStep(
      startAgentWorkflowStep(workflow, { stepId: 'inspect_first' }),
      { stepId: 'inspect_first', resultSummary: '第一次完成' },
    )
    expect(findRunnableAgentWorkflowStep(afterFirst, {
      ...invocation('inspect_dataset'),
      workflowStepId: 'inspect_second',
    })?.stepId).toBe('inspect_second')
  })

  it('rejects invalid execution contracts for automation and sub-agent steps', () => {
    expect(() => createAgentWorkflow({
      goal: '执行自动化流程',
      steps: [{ ...step('automation', 'list_automations'), kind: 'automation' }],
    })).toThrow('必须通过 execute_automation')
    expect(() => createAgentWorkflow({
      goal: '委托子智能体',
      steps: [{ ...step('agent', 'spatial_analyst'), kind: 'agent', ownerAgentId: 'other_agent' }],
    })).toThrow('必须与 Agent 工具名一致')
    expect(() => createAgentWorkflow({
      goal: '普通工具必须由主智能体领取',
      steps: [{ ...step('inspect', 'inspect_dataset'), ownerAgentId: 'spatial_analyst' }],
    })).toThrow("必须为 'supervisor'")
  })

  it('blocks dependants after failure and requires an explicit revision', () => {
    const workflow = createAgentWorkflow({
      goal: '失败后调整',
      steps: [step('a', 'tool_a'), step('b', 'tool_b', ['a']), step('c', 'tool_c', ['b'])],
    })
    const failed = failAgentWorkflowStep(
      startAgentWorkflowStep(workflow, { stepId: 'a' }),
      { stepId: 'a', errorMessage: '数据不可读' },
    )
    expect(failed.status).toBe('adjusting')
    expect(failed.steps.map(item => [item.stepId, item.status])).toEqual([
      ['a', 'failed'],
      ['b', 'blocked'],
      ['c', 'blocked'],
    ])
  })

  it('preserves only unchanged completed steps across revisions', () => {
    const initial = createAgentWorkflow({
      goal: '生成地图',
      steps: [step('a', 'inspect'), step('b', 'render', ['a'])],
    })
    const completedA = completeAgentWorkflowStep(
      startAgentWorkflowStep(initial, { stepId: 'a' }),
      { stepId: 'a', resultSummary: '探查完成' },
    )
    const revised = reviseAgentWorkflow(completedA, {
      goal: '生成地图和表格',
      changeReason: '用户新增表格要求',
      steps: [
        step('a', 'inspect'),
        step('b', 'render', ['a']),
        step('c', 'build_table', ['a']),
      ],
    })
    expect(revised.revision).toBe(2)
    expect(revised.steps.find(item => item.stepId === 'a')?.status).toBe('completed')
    expect(revised.steps.find(item => item.stepId === 'b')?.status).toBe('pending')
    expect(revised.steps.find(item => item.stepId === 'c')?.status).toBe('pending')

    const changed = reviseAgentWorkflow(revised, {
      goal: revised.goal,
      changeReason: '探查参数需要更新',
      steps: [
        { ...step('a', 'inspect'), args: { variable: 'QPF' } },
        step('b', 'render', ['a']),
        step('c', 'build_table', ['a']),
      ],
    })
    expect(changed.steps.find(item => item.stepId === 'a')?.status).toBe('pending')
  })

  it('completes the workflow only after every step reaches a terminal success state', () => {
    const workflow = createAgentWorkflow({ goal: '交付结论', steps: [step('answer', 'answer')] })
    const completed = completeAgentWorkflowStep(
      startAgentWorkflowStep(workflow, { stepId: 'answer' }),
      { stepId: 'answer', resultSummary: '已交付' },
    )
    expect(completed.status).toBe('completed')
    expect(completed.completedAt).toEqual(expect.any(String))
  })

  it('reopens a completed plan when delivery verification requires an explicit revision', () => {
    const completed = completeAgentWorkflowStep(
      startAgentWorkflowStep(
        createAgentWorkflow({ goal: '生成风险图', steps: [step('render', 'render_risk_map')] }),
        { stepId: 'render' },
      ),
      { stepId: 'render', resultSummary: '风险图已生成' },
    )

    const revised = reviseAgentWorkflow(completed, {
      goal: '生成风险图并补充面雨量表',
      changeReason: '交付前验证发现需要补充可核验表格',
      steps: [
        step('render', 'render_risk_map'),
        step('table', 'generate_area_rainfall_table', ['render']),
      ],
    })

    expect(revised).toMatchObject({
      revision: 2,
      status: 'running',
      completedAt: null,
      steps: [
        expect.objectContaining({ stepId: 'render', status: 'completed' }),
        expect.objectContaining({ stepId: 'table', status: 'pending' }),
      ],
    })
  })

  it('does not let an in-flight step from an older objective revision restore workflow completion', () => {
    const running = startAgentWorkflowStep(
      createAgentWorkflow({ goal: '交付结论', steps: [step('answer', 'answer')] }, 1),
      { stepId: 'answer' },
    )
    const invalidated = advanceAgentWorkflowObjectiveRevision(running, 2)
    const lateCompletion = completeAgentWorkflowStep(
      invalidated,
      { stepId: 'answer', resultSummary: '旧 revision 在途结果' },
    )

    expect(lateCompletion).toMatchObject({
      objectiveRevision: 2,
      status: 'adjusting',
      completedAt: null,
      steps: [expect.objectContaining({ status: 'completed' })],
    })
  })

  it('rejects duplicate and out-of-order step transitions', () => {
    const workflow = createAgentWorkflow({ goal: '保持状态一致', steps: [step('a', 'tool_a')] })
    expect(() => completeAgentWorkflowStep(workflow, {
      stepId: 'a',
      resultSummary: '不能跳过运行态',
    })).toThrow("当前状态为 'pending'，不能完成")

    const running = startAgentWorkflowStep(workflow, { stepId: 'a' })
    expect(() => startAgentWorkflowStep(running, { stepId: 'a' }))
      .toThrow("当前状态为 'running'，不能开始")
  })
})

function step(stepId: string, toolName: string, dependsOn: string[] = []) {
  return {
    stepId,
    title: `步骤 ${stepId}`,
    kind: 'tool' as const,
    toolName,
    ownerAgentId: 'supervisor',
    args: {},
    reason: `执行 ${toolName}`,
    dependsOn,
  }
}

function invocation(toolName: string) {
  return { toolName }
}

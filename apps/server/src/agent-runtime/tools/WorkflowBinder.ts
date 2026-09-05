// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具调用与工作流步骤绑定器
//
//   文件:       WorkflowBinder.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ToolRegistry } from '../../framework/registry.js'
import type { AgentWorkflow, AgentWorkflowStep, TodoItem } from '../../schemas/types.js'
import type { ToolExecutionStore } from '../../store/runtimePorts.js'
import {
  AGENT_WORKFLOW_CONTROL_TOOLS,
  completeAgentWorkflowStep,
  failAgentWorkflowStep,
  findRunnableAgentWorkflowStep,
  startAgentWorkflowStep,
} from '../../agent/agentWorkflowState.js'
import type { RunEventSink } from '../../agent/turnRunner.js'

interface WorkflowBinderOptions {
  store: Pick<ToolExecutionStore, 'getRun' | 'mutateRunState'>
  registry: ToolRegistry
  runId: string
  eventSink: RunEventSink
}

interface ClaimedWorkflowStep {
  readonly agentWorkflowId: string
  readonly workflowRevision: number
  readonly objectiveRevision: number
  readonly stepId: string
  readonly attempt: number
  readonly startedAt: string
}

/**
 * Owns the lineage between one tool call and one exact workflow step attempt.
 * Late calls may keep their tool result, but can never mutate a newer workflow revision or retry.
 */
export class WorkflowBinder {
  private readonly claims = new Map<string, ClaimedWorkflowStep>()
  private mutation: Promise<void> = Promise.resolve()

  constructor(private readonly options: WorkflowBinderOptions) {}

  claim(
    toolName: string,
    callId: string,
    ownerAgentId?: string,
    workflowStepId?: string | null,
  ): Promise<string | null> {
    if (AGENT_WORKFLOW_CONTROL_TOOLS.has(toolName)) return Promise.resolve(null)
    return this.enqueue(async () => {
      let claimedStepId: string | null = null
      const updated = await this.options.store.mutateRunState(this.options.runId, state => {
        const workflow = state.agentWorkflow
        if (!workflow) return {}
        if (workflow.status === 'adjusting' || workflow.status === 'completed') {
          const tool = this.options.registry.get(toolName)
          if (tool?.isReadOnly && !tool.isDestructive) return {}
          const phase = workflow.status === 'completed' ? '已完成当前计划步骤' : '正在等待调整'
          throw new Error(`智能体工作流${phase}。请先调用 revise_agent_workflow，再执行新的写入或外部操作。`)
        }
        if (workflow.status === 'cancelled' || workflow.status === 'failed') {
          throw new Error(`智能体工作流已经处于 ${workflow.status} 状态，不能继续调用工具。`)
        }
        const claimed = this.activeClaimedStepIds(workflow)
        const invocation = {
          toolName,
          ...(ownerAgentId ? { ownerAgentId } : {}),
          ...(workflowStepId ? { workflowStepId } : {}),
        }
        const step = findRunnableAgentWorkflowStep(workflow, invocation, claimed)
        if (!step) {
          assertWorkflowStepCanBeClaimed(
            workflow,
            claimed,
            toolName,
            ownerAgentId,
            workflowStepId,
          )
        }
        if (!step) throw new Error(`工具 '${toolName}' 不在当前智能体工作流的可执行步骤中。`)
        claimedStepId = step.stepId
        const next = startAgentWorkflowStep(workflow, { stepId: step.stepId })
        const nextStep = next.steps.find(item => item.stepId === step.stepId)
        if (!nextStep) throw new Error(`工具开始时智能体工作流步骤 '${step.stepId}' 不存在。`)
        return {
          agentWorkflow: next,
          todos: projectWorkflowStepToTodos(state.todos, nextStep),
        }
      })
      if (!claimedStepId) return null
      const workflow = updated.state.agentWorkflow
      if (!workflow) throw new Error('工具开始后智能体工作流状态缺失。')
      const step = workflow.steps.find(item => item.stepId === claimedStepId)
      if (!step) throw new Error(`工具开始后智能体工作流步骤 '${claimedStepId}' 不存在。`)
      this.claims.set(callId, workflowStepClaim(workflow, step))
      this.options.eventSink.emit('step.started', step.title, {
        agentWorkflowId: workflow.agentWorkflowId,
        revision: workflow.revision,
        objectiveRevision: workflow.objectiveRevision,
        stepId: step.stepId,
        attempt: step.attempt,
        toolName,
      })
      return step.stepId
    })
  }

  restoreExternalAgent(agentId: string, callId: string, stepId: string | null): void {
    const workflow = this.options.store.getRun(this.options.runId).state.agentWorkflow
    if (!stepId) {
      if (workflow) throw new Error(`子智能体 '${agentId}' 缺少可恢复的工作流步骤`)
      return
    }
    const step = workflow?.steps.find(candidate => candidate.stepId === stepId)
    if (!workflow
      || !step
      || step.status !== 'running'
      || step.kind !== 'agent'
      || step.toolName !== agentId
      || step.ownerAgentId !== agentId) {
      throw new Error(`子智能体 '${agentId}' 的运行中工作流步骤 '${stepId}' 无法恢复`)
    }
    this.claims.set(callId, workflowStepClaim(workflow, step))
  }

  complete(callId: string, summary: string): Promise<void> {
    const claim = this.claims.get(callId)
    if (!claim) return Promise.resolve()
    return this.enqueue(async () => {
      let completed: { workflow: AgentWorkflow; step: AgentWorkflowStep } | null = null
      await this.options.store.mutateRunState(this.options.runId, state => {
        const workflow = state.agentWorkflow
        if (!matchingClaimedWorkflowStep(workflow, claim)) return {}
        const next = completeAgentWorkflowStep(workflow, {
          stepId: claim.stepId,
          resultSummary: summary,
        })
        const step = next.steps.find(item => item.stepId === claim.stepId)
        if (!step) return {}
        completed = { workflow: next, step }
        return {
          agentWorkflow: next,
          todos: projectWorkflowStepToTodos(state.todos, step),
        }
      })
      this.clear(callId, claim)
      if (!completed) return
      const outcome = completed as { workflow: AgentWorkflow; step: AgentWorkflowStep }
      this.options.eventSink.emit('step.completed', outcome.step.title, {
        agentWorkflowId: outcome.workflow.agentWorkflowId,
        revision: outcome.workflow.revision,
        objectiveRevision: outcome.workflow.objectiveRevision,
        stepId: claim.stepId,
        attempt: claim.attempt,
        toolName: outcome.step.toolName,
      })
      if (outcome.workflow.status === 'completed') {
        this.options.eventSink.emit('agent_workflow.completed', outcome.workflow.goal, {
          agentWorkflowId: outcome.workflow.agentWorkflowId,
          revision: outcome.workflow.revision,
          objectiveRevision: outcome.workflow.objectiveRevision,
        })
      }
    })
  }

  fail(callId: string, message: string): Promise<void> {
    const claim = this.claims.get(callId)
    if (!claim) return Promise.resolve()
    return this.enqueue(async () => {
      let failed: { workflow: AgentWorkflow; step: AgentWorkflowStep } | null = null
      await this.options.store.mutateRunState(this.options.runId, state => {
        const workflow = state.agentWorkflow
        if (!matchingClaimedWorkflowStep(workflow, claim)) return {}
        const next = failAgentWorkflowStep(workflow, {
          stepId: claim.stepId,
          errorMessage: message,
        })
        const step = next.steps.find(item => item.stepId === claim.stepId)
        if (!step) return {}
        failed = { workflow: next, step }
        return {
          agentWorkflow: next,
          todos: projectWorkflowStepToTodos(state.todos, step),
        }
      })
      this.clear(callId, claim)
      if (!failed) return
      const outcome = failed as { workflow: AgentWorkflow; step: AgentWorkflowStep }
      this.options.eventSink.emit('warning.raised', `步骤执行失败：${message}`, {
        agentWorkflowId: outcome.workflow.agentWorkflowId,
        revision: outcome.workflow.revision,
        objectiveRevision: outcome.workflow.objectiveRevision,
        stepId: claim.stepId,
        attempt: claim.attempt,
      })
    })
  }

  activeClaimedStepIds(workflow: AgentWorkflow | null): Set<string> {
    return new Set(
      [...this.claims.values()]
        .filter(claim => matchingClaimedWorkflowStep(workflow, claim))
        .map(claim => claim.stepId),
    )
  }

  private clear(callId: string, claim: ClaimedWorkflowStep): void {
    if (this.claims.get(callId) === claim) this.claims.delete(callId)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutation.then(operation, operation)
    this.mutation = pending.then(() => undefined, () => undefined)
    return pending
  }
}

function assertWorkflowStepCanBeClaimed(
  workflow: AgentWorkflow,
  claimed: ReadonlySet<string>,
  toolName: string,
  ownerAgentId?: string,
  workflowStepId?: string | null,
): never {
  const planned = workflow.steps.filter(item => item.toolName === toolName && item.status === 'pending')
  const dependenciesSatisfied = planned.filter(item => item.dependsOn.every(dependency => (
    workflow.steps.some(candidate => (
      candidate.stepId === dependency
      && (candidate.status === 'completed' || candidate.status === 'skipped')
    ))
  )))
  if (ownerAgentId && dependenciesSatisfied.some(item => item.ownerAgentId !== ownerAgentId)) {
    throw new Error(`子智能体 '${ownerAgentId}' 不能领取分配给其他负责人的步骤。请先调用 revise_agent_workflow 调整负责人。`)
  }
  if (workflowStepId) {
    const requested = workflow.steps.find(item => item.stepId === workflowStepId)
    if (!requested) throw new Error(`工作流步骤 '${workflowStepId}' 不存在。`)
    if (requested.toolName !== toolName) {
      throw new Error(`工作流步骤 '${workflowStepId}' 声明的工具是 '${requested.toolName}'，不能绑定到 '${toolName}'。`)
    }
    if (requested.ownerAgentId !== (ownerAgentId ?? 'supervisor')) {
      throw new Error(`工作流步骤 '${workflowStepId}' 不属于当前执行者。`)
    }
    if (requested.status !== 'pending' || claimed.has(requested.stepId)) {
      throw new Error(`工作流步骤 '${workflowStepId}' 当前不可领取。`)
    }
    throw new Error(`工作流步骤 '${workflowStepId}' 的依赖尚未完成，不能提前执行。`)
  }
  const readyForOwner = dependenciesSatisfied.filter(item => (
    item.ownerAgentId === (ownerAgentId ?? 'supervisor')
    && !claimed.has(item.stepId)
  ))
  if (readyForOwner.length > 1) {
    throw new Error(
      `工具 '${toolName}' 同时对应多个可执行步骤（${readyForOwner.map(item => item.stepId).join('、')}），`
      + '必须通过 workflowStepId 指定本次执行步骤。',
    )
  }
  if (planned.length) {
    throw new Error(`工具 '${toolName}' 对应的计划步骤依赖尚未完成，不能提前执行。`)
  }
  throw new Error(`工具 '${toolName}' 不在当前智能体工作流的可执行步骤中。请先调用 revise_agent_workflow 显式调整工作流。`)
}

function workflowStepClaim(
  workflow: AgentWorkflow,
  step: AgentWorkflowStep,
): ClaimedWorkflowStep {
  if (step.status !== 'running' || !step.startedAt) {
    throw new Error(`工作流步骤 '${step.stepId}' 缺少可恢复的运行身份`)
  }
  return Object.freeze({
    agentWorkflowId: workflow.agentWorkflowId,
    workflowRevision: workflow.revision,
    objectiveRevision: workflow.objectiveRevision,
    stepId: step.stepId,
    attempt: step.attempt,
    startedAt: step.startedAt,
  })
}

function matchingClaimedWorkflowStep(
  workflow: AgentWorkflow | null,
  claim: ClaimedWorkflowStep,
): workflow is AgentWorkflow {
  if (!workflow
    || workflow.agentWorkflowId !== claim.agentWorkflowId
    || workflow.revision !== claim.workflowRevision
    || workflow.objectiveRevision !== claim.objectiveRevision) {
    return false
  }
  const step = workflow.steps.find(candidate => candidate.stepId === claim.stepId)
  return step?.status === 'running'
    && step.attempt === claim.attempt
    && step.startedAt === claim.startedAt
}

function projectWorkflowStepToTodos(todos: TodoItem[], step: AgentWorkflowStep): TodoItem[] {
  const status = step.status === 'skipped' ? 'completed' : step.status
  return todos.map(todo => todo.stepId === step.stepId ? { ...todo, status } : todo)
}

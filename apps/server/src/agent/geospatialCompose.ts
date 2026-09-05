// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地理分析 Compose 运行契约
//
//   文件:       geospatialCompose.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentWorkflowStepPhase } from '../schemas/types.js'
import type { ToolRegistry } from '../framework/registry.js'

interface ComposeSubAgentConfig {
  agentId: string
  tools?: string[]
}

interface PlannedComposeStep {
  stepId: string
  title: string
  kind: string
  phase: AgentWorkflowStepPhase | null
  toolName: string
  dependsOn: string[]
}

const REQUIRED_PHASES = [
  'discover',
  'validate',
  'analyze',
  'verify',
] as const satisfies readonly AgentWorkflowStepPhase[]

export function buildGeospatialComposePrompt(): string {
  return `## 地理分析 Compose 模式
- 当前运行不是普通自动问答，而是需要持续执行到可核验交付的地理分析项目。必须先形成结构化工作流，再按真实依赖执行；不要只展示计划后结束。
- 工作流每个步骤都必须填写 phase，且至少形成 discover → validate → analyze → verify 的依赖链。visualize 与 deliver 按用户交付要求选用，不得为了凑阶段调用无关工具。
- discover：确认目标、空间范围、时间范围、线程文件、平台图层和真实数据源。只能使用无副作用读取能力。
- validate：核验 CRS、数据完整性、变量、时次、单位、空间覆盖和工具前置条件。必须依赖 discover，并只能使用无副作用读取能力。
- analyze：执行真实 GIS 或气象计算。必须依赖 validate；跨工具数据只传 valueRef，不复制坐标、GeoJSON、大数组或宿主路径。
- visualize：仅在用户需要地图、图表或预览时生成 Artifact；有副作用的能力继续遵守自身审批。
- verify：在 analyze 之后使用无副作用读取工具或只读子智能体复核关键范围、数值、CRS、数据来源和产物引用。不得把主智能体自己的总结当作验证证据。
- deliver：仅在用户要求报告、导出或其它显式交付物时使用对应真实工具。最终中文回答不是虚构的 workflow 步骤。
- 缺少关键数据、空间/时间范围或交付选择时使用 request_clarification；能力不存在或验证失败时明确失败，不得缩减目标后宣称 Compose 已完成。`
}

export function validateGeospatialComposeWorkflowDraft(
  args: Record<string, unknown>,
  registry: ToolRegistry,
  subAgents: ReadonlyArray<ComposeSubAgentConfig>,
): string | null {
  const workflow = asRecord(args.workflow)
  const rawSteps = workflow && Array.isArray(workflow.steps) ? workflow.steps : []
  const steps: PlannedComposeStep[] = []

  for (const [index, rawStep] of rawSteps.entries()) {
    const step = asRecord(rawStep)
    if (!step) return `地理分析 Compose 工作流无效：第 ${index + 1} 个步骤不是 JSON object。`
    const phase = parsePhase(step.phase)
    if (!phase) {
      const title = nonEmptyString(step.title) ?? `第 ${index + 1} 个步骤`
      return `地理分析 Compose 工作流无效：步骤“${title}”缺少有效 phase。`
    }
    steps.push({
      stepId: nonEmptyString(step.stepId) ?? '',
      title: nonEmptyString(step.title) ?? `第 ${index + 1} 个步骤`,
      kind: nonEmptyString(step.kind) ?? '',
      phase,
      toolName: nonEmptyString(step.toolName) ?? '',
      dependsOn: Array.isArray(step.dependsOn)
        ? step.dependsOn.filter((value): value is string => typeof value === 'string')
        : [],
    })
  }

  for (const phase of REQUIRED_PHASES) {
    if (!steps.some(step => step.phase === phase)) {
      return `地理分析 Compose 工作流无效：缺少 '${phase}' 阶段。`
    }
  }

  const unsafeEvidenceStep = steps.find(step => (
    (step.phase === 'discover' || step.phase === 'validate' || step.phase === 'verify')
    && !isReadOnlyEvidenceStep(step, registry, subAgents)
  ))
  if (unsafeEvidenceStep) {
    return `地理分析 Compose 工作流无效：${unsafeEvidenceStep.phase} 阶段步骤“${unsafeEvidenceStep.title}”必须使用可核验的无副作用读取能力。`
  }

  const byId = new Map(steps.map(step => [step.stepId, step]))
  const discoverIds = new Set(steps.filter(step => step.phase === 'discover').map(step => step.stepId))
  const validate = steps.find(step => (
    step.phase === 'validate' && hasAncestorIn(step, discoverIds, byId)
  ))
  if (!validate) {
    return "地理分析 Compose 工作流无效：至少一个 validate 步骤必须直接或间接依赖 discover。"
  }

  const analyze = steps.find(step => (
    step.phase === 'analyze' && hasAncestorIn(step, new Set([validate.stepId]), byId)
  ))
  if (!analyze) {
    return "地理分析 Compose 工作流无效：至少一个 analyze 步骤必须直接或间接依赖 validate。"
  }

  const verify = steps.find(step => (
    step.phase === 'verify' && hasAncestorIn(step, new Set([analyze.stepId]), byId)
  ))
  if (!verify) {
    return "地理分析 Compose 工作流无效：至少一个 verify 步骤必须直接或间接依赖 analyze。"
  }

  return null
}

function isReadOnlyEvidenceStep(
  step: PlannedComposeStep,
  registry: ToolRegistry,
  subAgents: ReadonlyArray<ComposeSubAgentConfig>,
): boolean {
  if (step.kind !== 'agent') {
    const tool = registry.get(step.toolName)
    return Boolean(tool?.isReadOnly && !tool.isDestructive)
  }
  const subAgent = subAgents.find(candidate => candidate.agentId === step.toolName)
  if (!subAgent?.tools?.length) return false
  return subAgent.tools.every(toolName => {
    const tool = registry.get(toolName)
    return Boolean(tool?.isReadOnly && !tool.isDestructive)
  })
}

function hasAncestorIn(
  step: PlannedComposeStep,
  candidates: ReadonlySet<string>,
  byId: ReadonlyMap<string, PlannedComposeStep>,
): boolean {
  const pending = [...step.dependsOn]
  const visited = new Set<string>()
  while (pending.length) {
    const dependency = pending.pop()
    if (!dependency || visited.has(dependency)) continue
    if (candidates.has(dependency)) return true
    visited.add(dependency)
    pending.push(...(byId.get(dependency)?.dependsOn ?? []))
  }
  return false
}

function parsePhase(value: unknown): AgentWorkflowStepPhase | null {
  if (value === 'discover' || value === 'validate' || value === 'analyze'
    || value === 'visualize' || value === 'verify' || value === 'deliver') return value
  return null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

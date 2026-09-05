// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 图编译器
//
//   文件:       automationCompiler.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 Automation 图编译器。
// 它只接受共享协议解析后的图，负责结构、工具契约和数据依赖校验；
// 执行器只消费编译成功的结果，不在运行中猜测或修补无效图。

import { Ajv, type ValidateFunction } from 'ajv'
import type { ToolRegistry } from '../framework/registry.js'
import type {
  AutomationBinding,
  AutomationDefinition,
  AutomationEdge,
  AutomationNode,
  AutomationValidationIssue,
  AutomationValidationResult,
} from './schemas.js'

export interface CompiledAutomation {
  definition: AutomationDefinition
  nodesById: ReadonlyMap<string, AutomationNode>
  outgoingEdges: ReadonlyMap<string, AutomationEdge[]>
  incomingEdges: ReadonlyMap<string, AutomationEdge[]>
  topologicalOrder: readonly string[]
  validateParameters(parameters: Record<string, unknown>): void
}

export class AutomationCompiler {
  private readonly ajv = new Ajv({ allErrors: true, strict: true })

  constructor(private readonly tools: Pick<ToolRegistry, 'get'>) {}

  validate(definition: AutomationDefinition): AutomationValidationResult {
    const issues: AutomationValidationIssue[] = []
    const nodesById = new Map<string, AutomationNode>()
    const edgesById = new Set<string>()

    for (const node of definition.graph.nodes) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(node.nodeId)) {
        issues.push(issue('error', 'node_id_invalid', '节点 ID 必须以字母开头，并且只能包含字母、数字、下划线或连字符。', { nodeId: node.nodeId }))
      }
      if (nodesById.has(node.nodeId)) {
        issues.push(issue('error', 'duplicate_node_id', `节点 ID '${node.nodeId}' 重复。`, { nodeId: node.nodeId }))
      } else {
        nodesById.set(node.nodeId, node)
      }
    }

    const entry = nodesById.get(definition.graph.entryNodeId)
    if (!entry) {
      issues.push(issue('error', 'entry_missing', `入口节点 '${definition.graph.entryNodeId}' 不存在。`))
    } else if (entry.type !== 'trigger') {
      issues.push(issue('error', 'entry_not_trigger', '入口节点必须是触发器节点。', { nodeId: entry.nodeId }))
    }

    const triggerNodes = definition.graph.nodes.filter(node => node.type === 'trigger')
    if (triggerNodes.length !== 1) {
      issues.push(issue('error', 'trigger_count', `Automation 必须且只能包含一个触发器，当前为 ${triggerNodes.length} 个。`))
    }
    if (!definition.graph.nodes.some(node => node.type === 'output')) {
      issues.push(issue('error', 'output_missing', 'Automation 至少需要一个输出节点。'))
    }

    const outgoing = new Map<string, AutomationEdge[]>()
    const incoming = new Map<string, AutomationEdge[]>()
    for (const edge of definition.graph.edges) {
      if (edgesById.has(edge.edgeId)) {
        issues.push(issue('error', 'duplicate_edge_id', `连线 ID '${edge.edgeId}' 重复。`, { edgeId: edge.edgeId }))
        continue
      }
      edgesById.add(edge.edgeId)
      const source = nodesById.get(edge.sourceNodeId)
      const target = nodesById.get(edge.targetNodeId)
      if (!source || !target) {
        issues.push(issue('error', 'edge_endpoint_missing', `连线 '${edge.edgeId}' 指向不存在的节点。`, { edgeId: edge.edgeId }))
        continue
      }
      if (source.nodeId === target.nodeId) {
        issues.push(issue('error', 'self_edge', '节点不能连接到自身。', { edgeId: edge.edgeId, nodeId: source.nodeId }))
        continue
      }
      validateSourcePort(source, edge, issues)
      appendMapArray(outgoing, source.nodeId, edge)
      appendMapArray(incoming, target.nodeId, edge)
    }

    for (const node of definition.graph.nodes) {
      const nodeOutgoing = outgoing.get(node.nodeId) ?? []
      if (node.type === 'output' && nodeOutgoing.length) {
        issues.push(issue('error', 'output_has_edges', '输出节点不能再连接后续节点。', { nodeId: node.nodeId }))
      }
      if (node.type !== 'output' && nodeOutgoing.length === 0) {
        issues.push(issue('error', 'dead_end', '非输出节点必须连接后续节点。', { nodeId: node.nodeId }))
      }
      if (node.type === 'condition') {
        validateRequiredPorts(node.nodeId, nodeOutgoing, ['true', 'false'], issues)
      }
      if (node.type === 'approval') {
        validateRequiredPorts(node.nodeId, nodeOutgoing, ['approved', 'rejected'], issues)
      }
      if (node.type === 'trigger') {
        validateRequiredPorts(node.nodeId, nodeOutgoing, ['default'], issues)
      }
      if (node.type === 'tool' || node.type === 'agent') {
        if (!nodeOutgoing.some(edge => edge.sourcePort === 'success' || edge.sourcePort === 'default')) {
          issues.push(issue('error', 'success_path_missing', '工具或智能体节点至少需要一条成功出口。', { nodeId: node.nodeId }))
        }
        if (nodeOutgoing.filter(edge => edge.sourcePort === 'error').length > 1) {
          issues.push(issue('error', 'error_path_duplicated', '错误出口最多只能连接一次。', { nodeId: node.nodeId }))
        }
      }
      if (node.type === 'tool') validateToolNode(node, this.tools, issues)
      if (node.type === 'agent' && node.config.retry.maxAttempts > 1) {
        issues.push(issue(
          'error',
          'agent_retry_side_effect',
          '智能体节点可能调用有副作用的工具，不能自动重试；请将 maxAttempts 设为 1，并通过显式分支处理失败。',
          { nodeId: node.nodeId },
        ))
      }
    }

    const topologicalOrder = topologicalSort(nodesById, outgoing, incoming, issues)
    validateReachability(definition.graph.entryNodeId, nodesById, outgoing, issues)
    validateBindings(definition.graph.nodes, nodesById, incoming, issues)
    validateParameterSchema(this.ajv, definition, issues)
    validateRequiredParameterBindings(definition, issues)
    validateAgentInvocation(definition, this.tools, issues)

    const requiredTools = collectRequiredTools(definition.graph)

    const declared = [...definition.requiredTools].sort()
    if (JSON.stringify(requiredTools) !== JSON.stringify(declared)) {
      issues.push(issue(
        'warning',
        'required_tools_recomputed',
        'requiredTools 与图中的工具节点不一致；发布时将以图编译结果为准。',
      ))
    }

    return {
      valid: !issues.some(item => item.severity === 'error'),
      issues,
      topologicalOrder,
      requiredTools,
    }
  }

  compile(definition: AutomationDefinition): CompiledAutomation {
    const validation = this.validate(definition)
    if (!validation.valid) {
      const detail = validation.issues
        .filter(item => item.severity === 'error')
        .map(item => item.message)
        .join('；')
      throw new Error(`Automation '${definition.name}' 编译失败：${detail}`)
    }
    const normalized: AutomationDefinition = {
      ...definition,
      requiredTools: validation.requiredTools,
    }
    const nodesById = new Map(normalized.graph.nodes.map(node => [node.nodeId, node]))
    const outgoingEdges = groupEdges(normalized.graph.edges, 'sourceNodeId')
    const incomingEdges = groupEdges(normalized.graph.edges, 'targetNodeId')
    const parameterValidator = this.ajv.compile(normalized.parametersSchema)
    return {
      definition: normalized,
      nodesById,
      outgoingEdges,
      incomingEdges,
      topologicalOrder: validation.topologicalOrder,
      validateParameters(parameters) {
        const valid = parameterValidator(parameters)
        if (!valid) throw new Error(`Automation 参数无效：${formatAjvErrors(parameterValidator)}`)
      },
    }
  }
}

export function collectRequiredTools(graph: AutomationDefinition['graph']): string[] {
  return [...new Set(graph.nodes
    .filter((node): node is Extract<AutomationNode, { type: 'tool' }> => node.type === 'tool')
    .map(node => node.config.toolName))]
    .sort()
}

function validateToolNode(
  node: Extract<AutomationNode, { type: 'tool' }>,
  tools: Pick<ToolRegistry, 'get'>,
  issues: AutomationValidationIssue[],
): void {
  const tool = tools.get(node.config.toolName)
  if (!tool) {
    issues.push(issue('error', 'tool_missing', `工具“${node.label}”未注册。`, { nodeId: node.nodeId }))
    return
  }
  if (!(tool.executionSurfaces?.includes('automation') ?? true)) {
    issues.push(issue('error', 'tool_surface_forbidden', `工具“${tool.label}”不能在 Automation 中执行。`, {
      nodeId: node.nodeId,
    }))
  }
  if (node.config.retry.maxAttempts > 1 && tool.isReadOnly !== true) {
    issues.push(issue(
      'error',
      'tool_retry_side_effect',
      `工具“${tool.label}”不是只读工具，不能自动重试；请将 maxAttempts 设为 1，并通过显式分支处理失败。`,
      { nodeId: node.nodeId, path: 'config.retry.maxAttempts' },
    ))
  }
  const schema = tool.jsonSchema
  if (!schema || typeof schema !== 'object') return
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required.filter(item => typeof item === 'string') : []
  for (const argumentName of Object.keys(node.config.arguments)) {
    if (!(argumentName in properties) && schema.additionalProperties === false) {
      issues.push(issue('error', 'tool_argument_unknown', `工具“${tool.label}”不接受参数 '${argumentName}'。`, {
        nodeId: node.nodeId,
        path: `config.arguments.${argumentName}`,
      }))
    }
  }
  for (const requiredName of required) {
    if (!(requiredName in node.config.arguments)) {
      issues.push(issue('error', 'tool_argument_required', `工具“${tool.label}”缺少必填参数 '${requiredName}'。`, {
        nodeId: node.nodeId,
        path: `config.arguments.${requiredName}`,
      }))
    }
  }
}

function validateAgentInvocation(
  definition: AutomationDefinition,
  tools: Pick<ToolRegistry, 'get'>,
  issues: AutomationValidationIssue[],
): void {
  if (!definition.agentInvocation.enabled) return
  if (definition.outputType !== 'conversation') {
    issues.push(issue('error', 'agent_invocation_output_type', '可由 Agent 调用的 Automation 必须输出 conversation。'))
  }
  if (!definition.agentInvocation.description.trim()) {
    issues.push(issue('error', 'agent_invocation_description', '可由 Agent 调用的 Automation 必须提供调用说明。'))
  }
  if (!definition.agentInvocation.examples.length) {
    issues.push(issue('error', 'agent_invocation_examples', '可由 Agent 调用的 Automation 至少需要一个自然语言示例。'))
  }
  if (definition.graph.nodes.some(node => node.type === 'agent')) {
    issues.push(issue('error', 'agent_invocation_nested_agent', '可由 Agent 同步调用的 Automation 不能包含嵌套 Agent 节点。'))
  }
  if (definition.graph.nodes.some(node => node.type === 'approval')) {
    issues.push(issue('error', 'agent_invocation_approval', '可由 Agent 同步调用的 Automation 不能包含审批节点。'))
  }
  const outputHasAnswer = definition.graph.nodes.some(node => (
    node.type === 'output' && Object.hasOwn(node.config.outputs, 'answer')
  ))
  if (!outputHasAnswer) {
    issues.push(issue('error', 'agent_invocation_answer', '可由 Agent 调用的 Automation 必须通过输出节点提供 answer。'))
  }
  for (const node of definition.graph.nodes) {
    if (node.type !== 'tool') continue
    const tool = tools.get(node.config.toolName)
    if (!tool) continue
    if (node.config.approvalMode === 'always' || tool.isDestructive || tool.requiresApproval === true) {
      issues.push(issue('error', 'agent_invocation_tool_approval', `Agent 同步调用的 Automation 工具“${tool.label}”不能要求审批。`, {
        nodeId: node.nodeId,
      }))
    }
  }
}

function validateSourcePort(source: AutomationNode, edge: AutomationEdge, issues: AutomationValidationIssue[]): void {
  const allowed = source.type === 'condition'
    ? new Set(['true', 'false'])
    : source.type === 'approval'
      ? new Set(['approved', 'rejected'])
      : source.type === 'tool' || source.type === 'agent'
        ? new Set(['default', 'success', 'error'])
        : new Set(['default'])
  if (!allowed.has(edge.sourcePort)) {
    issues.push(issue('error', 'edge_port_invalid', `节点 '${source.label}' 不支持出口 '${edge.sourcePort}'。`, {
      nodeId: source.nodeId,
      edgeId: edge.edgeId,
    }))
  }
}

function validateRequiredPorts(
  nodeId: string,
  edges: AutomationEdge[],
  ports: readonly string[],
  issues: AutomationValidationIssue[],
): void {
  for (const port of ports) {
    const count = edges.filter(edge => edge.sourcePort === port).length
    if (count !== 1) {
      issues.push(issue('error', 'branch_port_count', `节点的 '${port}' 出口必须且只能连接一次。`, { nodeId }))
    }
  }
}

function topologicalSort(
  nodesById: Map<string, AutomationNode>,
  outgoing: Map<string, AutomationEdge[]>,
  incoming: Map<string, AutomationEdge[]>,
  issues: AutomationValidationIssue[],
): string[] {
  const indegrees = new Map([...nodesById.keys()].map(nodeId => [nodeId, incoming.get(nodeId)?.length ?? 0]))
  const ready = [...indegrees.entries()].filter(([, degree]) => degree === 0).map(([nodeId]) => nodeId).sort()
  const order: string[] = []
  while (ready.length) {
    const nodeId = ready.shift()
    if (!nodeId) break
    order.push(nodeId)
    for (const edge of outgoing.get(nodeId) ?? []) {
      const nextDegree = (indegrees.get(edge.targetNodeId) ?? 0) - 1
      indegrees.set(edge.targetNodeId, nextDegree)
      if (nextDegree === 0) {
        ready.push(edge.targetNodeId)
        ready.sort()
      }
    }
  }
  if (order.length !== nodesById.size) {
    issues.push(issue('error', 'graph_cycle', 'Automation 图包含环路；当前执行引擎只接受有向无环图。'))
  }
  return order
}

function validateReachability(
  entryNodeId: string,
  nodesById: Map<string, AutomationNode>,
  outgoing: Map<string, AutomationEdge[]>,
  issues: AutomationValidationIssue[],
): void {
  if (!nodesById.has(entryNodeId)) return
  const visited = new Set<string>()
  const stack = [entryNodeId]
  while (stack.length) {
    const nodeId = stack.pop()
    if (!nodeId || visited.has(nodeId)) continue
    visited.add(nodeId)
    for (const edge of outgoing.get(nodeId) ?? []) stack.push(edge.targetNodeId)
  }
  for (const nodeId of nodesById.keys()) {
    if (!visited.has(nodeId)) {
      issues.push(issue('error', 'node_unreachable', '节点无法从入口触发器到达。', { nodeId }))
    }
  }
}

function validateBindings(
  nodes: AutomationNode[],
  nodesById: Map<string, AutomationNode>,
  incoming: Map<string, AutomationEdge[]>,
  issues: AutomationValidationIssue[],
): void {
  for (const node of nodes) {
    for (const binding of bindingsOf(node)) {
      if (binding.source !== 'node' && binding.source !== 'value_ref') continue
      if (!nodesById.has(binding.nodeId)) {
        issues.push(issue('error', 'binding_node_missing', `数据绑定引用了不存在的节点 '${binding.nodeId}'。`, { nodeId: node.nodeId }))
        continue
      }
      if (binding.source === 'value_ref' && nodesById.get(binding.nodeId)?.type !== 'tool') {
        issues.push(issue('error', 'value_ref_source_not_tool', `valueRef 绑定只能引用工具节点 '${binding.nodeId}'。`, { nodeId: node.nodeId }))
        continue
      }
      if (!isAncestor(binding.nodeId, node.nodeId, incoming)) {
        issues.push(issue('error', 'binding_not_ancestor', `数据绑定节点 '${binding.nodeId}' 不是当前节点的上游依赖。`, { nodeId: node.nodeId }))
      }
    }
  }
}

function bindingsOf(node: AutomationNode): AutomationBinding[] {
  if (node.type === 'tool') return Object.values(node.config.arguments)
  if (node.type === 'condition') return [node.config.left, ...(node.config.right ? [node.config.right] : [])]
  if (node.type === 'output') return Object.values(node.config.outputs)
  return []
}

function isAncestor(candidateId: string, nodeId: string, incoming: Map<string, AutomationEdge[]>): boolean {
  const visited = new Set<string>()
  const stack = (incoming.get(nodeId) ?? []).map(edge => edge.sourceNodeId)
  while (stack.length) {
    const current = stack.pop()
    if (!current || visited.has(current)) continue
    if (current === candidateId) return true
    visited.add(current)
    for (const edge of incoming.get(current) ?? []) stack.push(edge.sourceNodeId)
  }
  return false
}

function validateParameterSchema(
  ajv: Ajv,
  definition: AutomationDefinition,
  issues: AutomationValidationIssue[],
): void {
  try {
    const validator = ajv.compile(definition.parametersSchema)
    if (!validator(definition.defaultParameters)) {
      issues.push(issue('error', 'default_parameters_invalid', `默认参数不符合参数 Schema：${formatAjvErrors(validator)}`))
    }
  } catch (error) {
    issues.push(issue('error', 'parameter_schema_invalid', `参数 Schema 无效：${errorMessage(error)}`))
  }
}

function validateRequiredParameterBindings(
  definition: AutomationDefinition,
  issues: AutomationValidationIssue[],
): void {
  const required = Array.isArray(definition.parametersSchema.required)
    ? definition.parametersSchema.required.filter((item): item is string => typeof item === 'string')
    : []
  if (!required.length) return

  const consumed = new Set<string>()
  let consumesAll = false
  const consumePath = (path: string): void => {
    if (path === 'parameters') {
      consumesAll = true
      return
    }
    if (!path.startsWith('parameters.')) return
    const parameterName = path.slice('parameters.'.length).split('.')[0]
    if (parameterName) consumed.add(parameterName)
  }

  for (const node of definition.graph.nodes) {
    for (const binding of bindingsOf(node)) {
      if (binding.source === 'input') consumePath(binding.path)
      if (binding.source === 'node' && binding.nodeId === definition.graph.entryNodeId) consumePath(binding.path)
    }
    if (node.type === 'agent') {
      for (const parameterName of required) {
        if (node.config.promptTemplate.includes(`input.parameters.${parameterName}`)) consumed.add(parameterName)
      }
    }
  }

  if (consumesAll) return
  for (const parameterName of required) {
    if (consumed.has(parameterName)) continue
    issues.push(issue(
      'error',
      'required_parameter_unused',
      `必填 Automation 参数 '${parameterName}' 没有绑定到任何节点，运行时传入该参数不会影响结果。`,
      { path: `parametersSchema.required.${parameterName}` },
    ))
  }
}

function formatAjvErrors(validator: ValidateFunction): string {
  return (validator.errors ?? [])
    .map(error => `${error.instancePath || '/'} ${error.message ?? '校验失败'}`)
    .join('；') || '参数不符合 Schema。'
}

function groupEdges(edges: AutomationEdge[], key: 'sourceNodeId' | 'targetNodeId'): Map<string, AutomationEdge[]> {
  const result = new Map<string, AutomationEdge[]>()
  for (const edge of edges) appendMapArray(result, edge[key], edge)
  return result
}

function appendMapArray(map: Map<string, AutomationEdge[]>, key: string, value: AutomationEdge): void {
  const current = map.get(key)
  if (current) current.push(value)
  else map.set(key, [value])
}

function issue(
  severity: AutomationValidationIssue['severity'],
  code: string,
  message: string,
  location: Partial<Pick<AutomationValidationIssue, 'nodeId' | 'edgeId' | 'path'>> = {},
): AutomationValidationIssue {
  return {
    severity,
    code,
    message,
    nodeId: location.nodeId ?? null,
    edgeId: location.edgeId ?? null,
    path: location.path ?? null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : '未知错误'
}

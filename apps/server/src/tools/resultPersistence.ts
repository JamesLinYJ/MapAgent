// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具结果持久化
//
//   文件:       resultPersistence.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// Agent 自动调用与 Debug 工作台直跑必须共享同一条结果持久化路径。PostgreSQL
// 是 Run、Tool Value 和 Artifact 元数据的结构化事实源；文件只保存 Artifact 内容。

import { lstat, rm } from 'node:fs/promises'
import path from 'node:path'
import type { ToolResult, ValueRef } from '../framework/types.js'
import type { AgentState, ArtifactRef, ClarificationState, DecisionRequest, AgentWorkflow, TodoItem, ToolValueRef } from '../schemas/types.js'
import type { ToolExecutionStore } from '../store/runtimePorts.js'
import {
  geoJsonSpatialMetadata,
  normalizeGeoJsonToCrs84,
  requireRenderableCrs84Bounds,
  type CanonicalGeoJson,
} from '../gis/geojsonCrs.js'
import { atomicWriteText } from '../store/durableFileIo.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { createAgentWorkflow, reviseAgentWorkflow } from '../agent/agentWorkflowState.js'
import type { ToolInvocationEffectCommit } from '../store/postgres/conversationPersistencePorts.js'

export interface ToolResultCommitInput {
  runId: string
  toolName: string
  toolLabel: string
  args: Record<string, unknown>
  result: ToolResult
  objectiveRevision: number
  invocation: ToolInvocationEffectCommit
}

export interface ToolResultCommitOutcome {
  controlsApplied: boolean
}

/**
 * The single durable boundary for a tool result.
 *
 * Tool execution may be initiated by the Agents SDK, the debug command, or an
 * automation node. None of those callers should know how generated artifacts
 * are staged or how idempotent result commits are reconciled with PostgreSQL.
 * This service owns that protocol and deliberately does not turn a failed
 * commit into a successful result.
 */
export class ToolResultCommitService {
  constructor(private readonly store: ToolExecutionStore) {}

  async commit(input: ToolResultCommitInput): Promise<ToolResultCommitOutcome> {
    const { runId, toolName, toolLabel, args, result, objectiveRevision, invocation } = input
    const { store } = this
    const refs: ToolValueRef[] = (result.valueRefs ?? []).map(ref => ({
      ...ref,
      sourceTool: toolName,
      sourceResultId: result.resultId,
      metadata: { ...(ref.metadata ?? {}), objectiveRevision },
      createdAt: nowUtc(),
      unit: ref.unit ?? null,
    }))
    const explicitArtifacts: ArtifactRef[] = (result.artifacts ?? []).map(artifact => {
      const relativePath = requireRunArtifactRelativePath(runId, artifact.relativePath)
      return {
        artifactId: artifact.artifactId,
        runId,
        artifactType: artifact.artifactType,
        name: artifact.name,
        uri: artifact.uri,
        display: artifact.display,
        metadata: { ...(artifact.metadata ?? {}), relativePath, objectiveRevision },
        isIntermediate: false,
      }
    })
    let generatedArtifacts: ArtifactRef[] = []
    try {
      await Promise.all(explicitArtifacts.map(artifact => (
        requireRunArtifactFile(store.runtimeRoot, runId, artifact.metadata.relativePath)
      )))
      generatedArtifacts = await createGeoArtifacts(result, runId, store.runtimeRoot)
      const artifacts = dedupeArtifacts([...explicitArtifacts, ...generatedArtifacts]).map(artifact => ({
        ...artifact,
        metadata: { ...artifact.metadata, objectiveRevision },
      }))
      const toolResult = {
        stepId: makeId('step'),
        objectiveRevision,
        tool: toolName,
        toolLabel,
        args,
        status: 'completed' as const,
        message: result.message,
        startedAt: null,
        completedAt: nowUtc(),
        resultId: result.resultId,
        source: result.source,
        confidence: null,
        usedQuery: null,
        provenance: result.provenance ?? {},
        crs: {},
        geometryType: null,
        featureCount: null,
        valueRefs: refs,
      }
      let controlsEligible = false
      const mutation = (state: AgentState): Partial<AgentState> => {
        controlsEligible = state.objectiveRevision === objectiveRevision
        const controlState = controlsEligible
          ? {
              ...agentWorkflowControlState(
                result.payload,
                state.agentWorkflow,
                state.todos,
                objectiveRevision,
              ),
              ...clarificationControlState(result.payload, state.decisions),
              ...todoControlState(result.payload),
            }
          : {}
        return {
          toolValueRefs: dedupeValueRefs([...state.toolValueRefs, ...refs]),
          artifacts: dedupeArtifacts([...state.artifacts, ...artifacts]),
          ...controlState,
          toolResults: [
            ...state.toolResults.filter(item => item.resultId !== result.resultId),
            toolResult,
          ],
        }
      }
      const commit = await store.commitToolResult(
        runId,
        result.resultId,
        mutation,
        invocation,
        refs,
        artifacts,
      )
      if (!commit.committed) {
        // 并发幂等重放可能复用同一个显式 artifact path。重新读取 durable
        // 所有权，只清理没有被任何已提交 Artifact 引用的显式文件；自动生成
        // 文件使用本次唯一 ID，可以直接清理。
        await removeArtifactFiles(store.runtimeRoot, runId, [
          ...generatedArtifacts,
          ...unownedExplicitArtifacts(store, runId, explicitArtifacts),
        ])
      }
      return { controlsApplied: commit.committed && controlsEligible }
    } catch (error) {
      // PostgreSQL 事务失败时，文件已经完成原子写入但没有对应的 durable
      // metadata。立即清理本次请求的对象，避免把“未提交”误留成可读结果；
      // GC 仍可处理进程在清理前崩溃的极端残留。
      await removeArtifactFiles(store.runtimeRoot, runId, [
        ...generatedArtifacts,
        ...unownedExplicitArtifacts(store, runId, explicitArtifacts),
      ])
      throw error
    }
  }
}

function unownedExplicitArtifacts(
  store: ToolExecutionStore,
  runId: string,
  candidates: ArtifactRef[],
): ArtifactRef[] {
  let durable: ArtifactRef[]
  try {
    durable = store.getRun(runId).state.artifacts
  } catch {
    // 无法证明文件没有 durable 所有者时宁可交给 GC，不能删除可能已发布的内容。
    return []
  }
  const durableIds = new Set(durable.map(artifact => artifact.artifactId))
  const durablePaths = new Set(durable.map(artifact => artifact.metadata.relativePath).filter((value): value is string => typeof value === 'string'))
  return candidates.filter(artifact => {
    const relativePath = artifact.metadata.relativePath
    return !durableIds.has(artifact.artifactId)
      && (typeof relativePath !== 'string' || !durablePaths.has(relativePath))
  })
}

// 智能体工作流由系统工具提交或修订。结构和依赖图在领域状态机中验证，
// 不允许持久化层用缺省值修补模型生成的无效计划。
function agentWorkflowControlState(
  payload: Record<string, unknown>,
  current: AgentWorkflow | null,
  currentTodos: TodoItem[],
  objectiveRevision: number,
): Partial<{
  planMode: boolean
  agentWorkflow: AgentWorkflow
  todos: TodoItem[]
}> {
  const updates: Partial<{ planMode: boolean; agentWorkflow: AgentWorkflow; todos: TodoItem[] }> = {}
  if (typeof payload.planMode === 'boolean') updates.planMode = payload.planMode
  if (isRecord(payload.agentWorkflowDraft)) {
    const workflow = createAgentWorkflow(payload.agentWorkflowDraft, objectiveRevision)
    updates.agentWorkflow = workflow
    updates.todos = projectWorkflowTodos(workflow, currentTodos)
  }
  if (isRecord(payload.agentWorkflowRevision)) {
    if (!current) throw new Error('当前运行没有可以调整的智能体工作流。')
    const workflow = reviseAgentWorkflow(current, payload.agentWorkflowRevision, objectiveRevision)
    updates.agentWorkflow = workflow
    updates.todos = projectWorkflowTodos(workflow, currentTodos)
  }
  return updates
}

function projectWorkflowTodos(workflow: AgentWorkflow, currentTodos: TodoItem[]): TodoItem[] {
  const existingByStep = new Map(currentTodos
    .filter(todo => todo.stepId)
    .map(todo => [todo.stepId as string, todo]))
  const independentTodos = currentTodos.filter(todo => !todo.stepId)
  const workflowTodos = workflow.steps.map(step => {
    const existing = existingByStep.get(step.stepId)
    return {
      todoId: existing?.todoId ?? makeId('todo'),
      title: step.title,
      status: step.status === 'skipped' ? 'completed' as const : step.status,
      description: step.reason,
      activeForm: step.status === 'running' ? `正在${step.title}` : null,
      ownerAgentId: step.ownerAgentId,
      stepId: step.stepId,
    }
  })
  return [...independentTodos, ...workflowTodos]
}

// 澄清是单次 run 的显式终止原因，不等于退出计划模式。
// 工具把结构化问题写入这里，UI/SSE 不再从 assistant 正文里猜测澄清状态。
function clarificationControlState(
  payload: Record<string, unknown>,
  currentDecisions: DecisionRequest[],
): Partial<{ clarification: ClarificationState | null; decisions: DecisionRequest[] }> {
  if (!isRecord(payload.clarification)) return {}
  const raw = payload.clarification
  const options = Array.isArray(raw.options)
    ? raw.options.filter(isRecord).map((option, index) => ({
      optionId: typeof option.optionId === 'string' ? option.optionId : `clarification_option_${index + 1}`,
      label: typeof option.label === 'string' && option.label.trim() ? option.label.trim() : `选项 ${index + 1}`,
      description: typeof option.description === 'string' ? option.description : '',
      kind: typeof option.kind === 'string' ? option.kind : 'generic',
      reason: typeof option.reason === 'string' ? option.reason : null,
      payload: isRecord(option.payload) ? option.payload : {},
    }))
    : []
  const clarification: ClarificationState = {
    clarificationId: typeof raw.clarificationId === 'string' && raw.clarificationId.trim()
      ? raw.clarificationId.trim()
      : makeId('clarification'),
    kind: typeof raw.kind === 'string' && raw.kind.trim() ? raw.kind.trim() : 'generic',
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : 'generic',
    question: typeof raw.question === 'string' && raw.question.trim() ? raw.question.trim() : '请补充必要信息。',
    options,
    selectedOptionId: typeof raw.selectedOptionId === 'string' ? raw.selectedOptionId : null,
    allowFreeText: typeof raw.allowFreeText === 'boolean' ? raw.allowFreeText : true,
  }
  const decision: DecisionRequest = {
    decisionId: clarification.clarificationId,
    kind: 'clarification',
    title: '需要补充信息',
    question: clarification.question,
    description: clarification.reason,
    options: clarification.options,
    allowFreeText: clarification.allowFreeText,
    status: 'pending',
    payload: {
      clarificationId: clarification.clarificationId,
      clarificationKind: clarification.kind,
      reason: clarification.reason,
    },
    createdAt: nowUtc(),
    resolvedAt: null,
  }
  return { clarification, decisions: upsertDecision(currentDecisions, decision) }
}

function upsertDecision(decisions: DecisionRequest[], decision: DecisionRequest): DecisionRequest[] {
  const next = decisions.filter(item => item.decisionId !== decision.decisionId)
  return [...next, decision]
}

// todo_write 的 payload 是运行状态更新，不是普通文本结果。统一在工具持久化
// 入口写回 AgentState，确保时间线、右侧结果和 DebugPage 看到同一份 Todo。
function todoControlState(payload: Record<string, unknown>): Partial<{ todos: TodoItem[] }> {
  if (!Array.isArray(payload.todos)) return {}
  return { todos: payload.todos.map((todo, index) => normalizeTodoItem(todo, index)) }
}

function normalizeTodoItem(value: unknown, index: number): TodoItem {
  const raw = isRecord(value) ? value : {}
  const status = typeof raw.status === 'string' && ['pending', 'running', 'completed', 'failed', 'blocked'].includes(raw.status)
    ? raw.status as TodoItem['status']
    : 'pending'
  return {
    todoId: typeof raw.todoId === 'string' && raw.todoId.trim() ? raw.todoId.trim() : `todo_${index + 1}`,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : `Todo ${index + 1}`,
    status,
    description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : null,
    activeForm: typeof raw.activeForm === 'string' && raw.activeForm.trim() ? raw.activeForm.trim() : null,
    ownerAgentId: typeof raw.ownerAgentId === 'string' && raw.ownerAgentId.trim() ? raw.ownerAgentId.trim() : null,
    stepId: typeof raw.stepId === 'string' && raw.stepId.trim() ? raw.stepId.trim() : null,
  }
}

export function resolveRuntimeValueRef(state: Map<string, unknown>, refId: string): ValueRef {
  const value = state.get(refId)
  if (!isRecord(value) || typeof value.refId !== 'string') throw new Error(`未知 valueRef：${refId}`)
  return value as unknown as ValueRef
}

async function createGeoArtifacts(result: ToolResult, runId: string, runtimeRoot: string): Promise<ArtifactRef[]> {
  const plans: GeoArtifactPlan[] = []
  const serialized = new Set<string>()
  const seenGeoJsonObjects = new WeakSet<object>()
  for (const ref of result.valueRefs ?? []) {
    const geojson = extractGeoJson(ref.value, ref.kind)
    if (!geojson) continue
    if (seenGeoJsonObjects.has(geojson)) continue
    seenGeoJsonObjects.add(geojson)
    const canonical = normalizeGeoJsonToCrs84(geojson, `valueRef '${ref.refId}'`, ref.metadata?.crs)
    appendGeoArtifactPlan(plans, serialized, ref.label || result.message, ref.kind, canonical)
  }
  for (const [key, value] of Object.entries(result.payload)) {
    const geojson = extractGeoJson(value)
    if (!geojson) continue
    // 工具通常会把同一个 GeoJSON 对象同时放进 payload 和 valueRef。按对象
    // 身份先去重，避免再次解析、重投影和序列化；深拷贝候选仍由 canonical
    // 内容集合去重，保持确定性。
    if (seenGeoJsonObjects.has(geojson)) continue
    seenGeoJsonObjects.add(geojson)
    const canonical = normalizeGeoJsonToCrs84(geojson, `工具结果 payload.${key}`)
    appendGeoArtifactPlan(plans, serialized, key === 'route' ? '规划路线' : key, key, canonical)
  }
  // 所有候选必须先完成解析、CRS 规范化和去重，之后才允许第一次文件写入。
  // 写阶段若部分成功后失败，立即清理本轮已发布的文件。
  const artifacts: ArtifactRef[] = []
  try {
    for (const plan of plans) artifacts.push(await writeGeoArtifact(runtimeRoot, runId, plan))
    return artifacts
  } catch (error) {
    await removeArtifactFiles(runtimeRoot, runId, artifacts)
    throw error
  }
}

interface GeoArtifactPlan {
  name: string
  kind: string
  canonical: CanonicalGeoJson
  content: string
}

function appendGeoArtifactPlan(
  plans: GeoArtifactPlan[],
  serialized: Set<string>,
  name: string,
  kind: string,
  canonical: CanonicalGeoJson,
): void {
  requireRenderableCrs84Bounds(canonical.bounds, 'GeoJSON Artifact')
  const content = JSON.stringify(canonical.entity)
  if (serialized.has(content)) return
  serialized.add(content)
  plans.push({ name, kind, canonical, content })
}

async function writeGeoArtifact(
  runtimeRoot: string,
  runId: string,
  plan: GeoArtifactPlan,
): Promise<ArtifactRef> {
  const { canonical, content, kind, name } = plan
  const bounds = requireRenderableCrs84Bounds(canonical.bounds, 'GeoJSON Artifact')
  const artifactId = makeId('artifact')
  const relativePath = path.posix.join('artifacts', runId, `${artifactId}.geojson`)
  const root = path.resolve(runtimeRoot)
  const target = path.resolve(root, relativePath)
  if (!target.startsWith(root + path.sep)) throw new Error('artifact 路径越出 runtime 根目录')
  const artifact: ArtifactRef = {
    artifactId,
    runId,
    artifactType: 'geojson',
    name,
    uri: `/api/v1/results/${artifactId}/geojson`,
    display: {
      surfaces: ['map', 'download'],
      primarySurface: 'map',
      map: {
        title: name,
        replacementGroup: null,
        bounds,
        crs: canonical.crs,
        minZoom: 0,
        maxZoom: 22,
        source: {
          kind: 'geojson',
          url: `/api/v1/results/${artifactId}/geojson`,
          featureCount: countGeoJsonFeatures(canonical.entity),
          sizeBytes: Buffer.byteLength(content, 'utf8'),
        },
        style: defaultGeoJsonStyle(canonical.entity),
        legend: null,
        temporal: null,
        capabilities: {
          query: true,
          labels: true,
          style: true,
          temporal: false,
          opacity: true,
          download: true,
        },
      },
    },
    metadata: { relativePath, kind, ...geoJsonSpatialMetadata(canonical) },
    isIntermediate: false,
  }
  // 描述符和全部派生元数据先在内存中构造完成，再原子发布内容，避免后续
  // 派生失败留下没有对应事务记录的文件。
  await atomicWriteText(target, content)
  return artifact
}

async function removeArtifactFiles(
  runtimeRoot: string,
  runId: string,
  artifacts: readonly ArtifactRef[],
): Promise<void> {
  const root = path.resolve(runtimeRoot)
  for (const artifact of artifacts) {
    const target = resolveRunArtifactPath(root, runId, artifact.metadata.relativePath)
    await rm(target, { force: true })
  }
}

async function requireRunArtifactFile(runtimeRoot: string, runId: string, value: unknown): Promise<string> {
  const relativePath = requireRunArtifactRelativePath(runId, value)
  const target = resolveRunArtifactPath(path.resolve(runtimeRoot), runId, relativePath)
  let entry: Awaited<ReturnType<typeof lstat>>
  try {
    entry = await lstat(target)
  } catch (error) {
    throw new Error(`artifact 文件不存在：${relativePath}`, { cause: error })
  }
  if (!entry.isFile()) throw new Error(`artifact 不是常规文件：${relativePath}`)
  return relativePath
}

function resolveRunArtifactPath(runtimeRoot: string, runId: string, value: unknown): string {
  const relativePath = requireRunArtifactRelativePath(runId, value)
  const target = path.resolve(runtimeRoot, relativePath)
  if (!target.startsWith(runtimeRoot + path.sep)) throw new Error('artifact 路径越出 runtime 根目录')
  return target
}

function requireRunArtifactRelativePath(runId: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('artifact 缺少 relativePath')
  const relativePath = value.trim()
  if (relativePath.includes('\\')) throw new Error('artifact relativePath 必须使用 POSIX 分隔符')
  const normalized = path.posix.normalize(relativePath)
  const runRoot = path.posix.join('artifacts', runId)
  if (normalized !== relativePath || !normalized.startsWith(`${runRoot}/`)) {
    throw new Error(`artifact relativePath 必须位于当前运行目录 ${runRoot}/`)
  }
  return normalized
}

function countGeoJsonFeatures(geojson: { type: string; features?: unknown[] }): number {
  if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) return geojson.features.length
  return 1
}

function defaultGeoJsonStyle(geojson: unknown) {
  const geometryTypes = new Set<string>()
  collectGeoJsonGeometryTypes(geojson, geometryTypes)
  if ([...geometryTypes].some(type => type.includes('Polygon'))) {
    return {
      kind: 'polygon' as const,
      color: '#2563eb',
      opacity: 0.55,
      colorField: null,
      categories: [],
      outlineColor: '#1d4ed8',
      outlineWidth: 1,
    }
  }
  if ([...geometryTypes].some(type => type.includes('LineString'))) {
    return {
      kind: 'line' as const,
      color: '#2563eb',
      opacity: 0.9,
      colorField: null,
      categories: [],
      width: 2,
      dashArray: null,
    }
  }
  return {
    kind: 'point' as const,
    color: '#2563eb',
    opacity: 0.9,
    colorField: null,
    categories: [],
    radius: 6,
    strokeColor: '#ffffff',
    strokeWidth: 1,
    cluster: false,
  }
}

function collectGeoJsonGeometryTypes(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectGeoJsonGeometryTypes(child, output)
    return
  }
  if (!isRecord(value)) return
  if (typeof value.type === 'string' && value.type !== 'Feature' && value.type !== 'FeatureCollection') output.add(value.type)
  if (Array.isArray(value.features)) collectGeoJsonGeometryTypes(value.features, output)
  if ('geometry' in value) collectGeoJsonGeometryTypes(value.geometry, output)
  if (Array.isArray(value.geometries)) collectGeoJsonGeometryTypes(value.geometries, output)
}

function extractGeoJson(value: unknown, kind?: string): Record<string, unknown> | null {
  if (kind && !['geojson', 'route', 'feature_collection'].includes(kind)) return null
  return isGeoJsonObject(value) ? value : null
}

function isGeoJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && [
    'FeatureCollection', 'Feature', 'LineString', 'Point', 'Polygon',
    'MultiLineString', 'MultiPoint', 'MultiPolygon', 'GeometryCollection',
  ].includes(String(value.type))
}

function dedupeArtifacts<T extends ArtifactRef>(artifacts: T[]): T[] {
  return [...new Map(artifacts.map(artifact => [artifact.artifactId, artifact])).values()]
}

function dedupeValueRefs<T extends ToolValueRef>(refs: T[]): T[] {
  return [...new Map(refs.map(ref => [ref.refId, ref])).values()]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

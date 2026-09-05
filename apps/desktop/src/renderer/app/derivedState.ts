// +-------------------------------------------------------------------------
//
//   地理智能平台 - AppShell 派生状态工具
//
//   文件:       derivedState.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// AppShell 的纯派生逻辑：状态文案、上传分类、数据引用摘要、
// 进度投影和地图结果描述。这里不发起 API 请求，也不持有 React state。

import type {
AgentState,
AnalysisRun,
ArtifactRef,
AgentWorkflow,
LayerDescriptor,
RunEvent,
UserIntent,
} from '@geo-agent-platform/shared-types'
import { METEOROLOGICAL_UPLOAD_SUFFIXES } from '@geo-agent-platform/shared-types/meteorology'
import type { DesktopFileSelectionHandle } from '../../contracts/desktopIpc'
import type { FileEntry } from '../api/client'
import type { DataReferenceSummary } from '../shared/constants'
import type { UploadReference } from './types'

const LAYER_FILE_SUFFIXES = new Set(['.geojson', '.json', '.gpkg', '.zip'])
const METEOROLOGICAL_FILE_SUFFIXES = new Set<string>(METEOROLOGICAL_UPLOAD_SUFFIXES)

export function formatModelRunStatus(status?: AnalysisRun['status']) {
  if (status === 'running' || status === 'queued') return '调用中'
  if (status === 'completed') return '已完成'
  if (status === 'waiting_approval') return '待审批'
  if (status === 'clarification_needed') return '待澄清'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  return '待命'
}

export function mergeThreadRuns(currentRuns: AnalysisRun[], incomingRun: AnalysisRun) {
  // 线程运行合并
  //
  // 新 run 启动后先把它乐观并入当前 thread 视图，
  // 这样首页在 WebSocket 快照继续推进前也能保持对话连续。
  const byId = new Map<string, AnalysisRun>()
  for (const item of currentRuns) {
    byId.set(item.id, item)
  }
  byId.set(incomingRun.id, incomingRun)
  return [...byId.values()].sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime()
    const rightTime = new Date(right.createdAt).getTime()
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
      return left.id.localeCompare(right.id)
    }
    return leftTime - rightTime
  })
}

export function classifyUploadFile(file: DesktopFileSelectionHandle): UploadReference['kind'] | undefined {
  if (isMeteorologicalFile(file)) {
    return 'meteorology'
  }
  if (isLayerFile(file)) {
    return 'layer'
  }
  return file.name.trim() ? 'file' : undefined
}

function isLayerFile(file: DesktopFileSelectionHandle) {
  const name = file.name.toLowerCase()
  return [...LAYER_FILE_SUFFIXES].some((suffix) => name.endsWith(suffix))
}

function isMeteorologicalFile(file: DesktopFileSelectionHandle) {
  const name = file.name.toLowerCase()
  return [...METEOROLOGICAL_FILE_SUFFIXES].some((suffix) => name.endsWith(suffix))
}

export function getUploadRelativePath(file: DesktopFileSelectionHandle) {
  return file.relativePath
}

export function makeUploadReferenceId(
  kind: UploadReference['kind'],
  relativePath: string,
  file: DesktopFileSelectionHandle,
) {
  return `${kind}:${relativePath}:${file.sizeBytes}:${file.modifiedAtMs}`
}

export function upsertUploadReference(current: UploadReference[], incoming: UploadReference) {
  const next = current.filter((item) => item.id !== incoming.id)
  return [incoming, ...next].slice(0, 80)
}

export function buildDataReferences({
  layers,
  uploadReferences,
  files,
  artifacts,
  threadRuns,
  currentThreadId,
}: {
  layers: LayerDescriptor[]
  uploadReferences: UploadReference[]
  files: FileEntry[]
  artifacts: ArtifactRef[]
  threadRuns: ReadonlyArray<AnalysisRun>
  currentThreadId?: string
}): DataReferenceSummary[] {
  // 数据引用摘要
  //
  // 聊天面板只展示当前 thread 关联的数据引用：上传队列、本 thread run
  // 产出的 artifact。session 级图层/气象数据只在有活跃 thread 时才展示，
  // 避免新建对话时看到旧 thread 的上传数据。
  const result: DataReferenceSummary[] = []
  const seen = new Set<string>()
  const layerByName = new Map(layers.map((layer) => [layer.name, layer]))
  const threadArtifactIds = new Set(
    threadRuns.flatMap((item) => item.state.artifacts.map((artifact) => artifact.artifactId)),
  )

  for (const item of uploadReferences) {
    if (item.isAggregate) continue
    const key = `${item.kind}:${item.relativePath ?? item.name}`
    seen.add(key)
    seen.add(`${item.kind}:${item.name}`)
    const matchedLayer = item.kind === 'layer' ? layerByName.get(item.name) : undefined
    result.push({
      id: `upload:${item.id}`,
      kind: item.kind,
      name: item.name,
      status: matchedLayer ? (matchedLayer.status === 'active' ? '可用' : matchedLayer.status) : uploadStatusLabel(item.status),
      detail: matchedLayer ? `${matchedLayer.featureCount ?? 0} 个对象 · ${matchedLayer.geometryType || '图层'}` : item.detail ?? formatReferenceKind(item.kind),
      relativePath: item.relativePath,
    })
  }

  // session 级图层只在有活跃 thread 上下文时展示；
  // 没有 thread 上下文时跳过，避免新建对话看到旧 thread 的数据。
  if (currentThreadId) {
    for (const file of files) {
      const displayPath = file.sourceRelativePath ?? file.name
      const key = `file:${displayPath}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      result.push({
        id: `file:${file.id}`,
        kind: 'file',
        name: file.name,
        status: uploadStatusLabel(file.status),
        detail: `${file.size} · 线程文件`,
        relativePath: file.sourceRelativePath ?? file.relativePath,
      })
    }

    for (const layer of layers) {
      if (!layer.sessionId && !layer.sourceType.startsWith('session_') && layer.sourceType !== 'upload') {
        continue
      }
      const key = `layer:${layer.name}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      result.push({
        id: `layer:${layer.layerKey}`,
        kind: 'layer',
        name: layer.name,
        status: layer.status === 'active' ? '可用' : layer.status,
        detail: `${layer.featureCount ?? 0} 个对象 · ${layer.geometryType || '图层'}`,
      })
    }
  }

  for (const artifact of artifacts) {
    if (!threadArtifactIds.has(artifact.artifactId)) {
      continue
    }
    const key = `artifact:${artifact.artifactId}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push({
      id: key,
      kind: 'artifact',
      name: artifact.name,
      status: '结果',
      detail: artifact.artifactType === 'raster_png' ? '栅格结果' : artifact.artifactType,
    })
  }

  return result.slice(0, 80)
}

function formatReferenceKind(kind: UploadReference['kind']) {
  if (kind === 'meteorology') return '气象数据'
  return kind === 'layer' ? '空间图层' : '线程文件'
}

function uploadStatusLabel(status: string) {
  if (status === 'pending') return '等待上传'
  if (status === 'uploading') return '上传中'
  if (status === 'ready') return '可用'
  if (status === 'failed') return '失败'
  if (status === 'running') return '处理中'
  if (status === 'queued') return '等待处理'
  return status || '已接入'
}

export function formatFileSize(size: number) {
  if (size >= 1024 * 1024 * 1024) {
    return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
  }
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }
  return `${size} B`
}

export type ProgressTodoItem = { id: string; content: string; status: string; activeForm: string }
export type RuntimeTokenBudget = { used: number; max: number; status: 'normal' | 'warning' | 'critical' | 'exceeded' }
export type RuntimeRunStats = { toolAttempts: number; toolSuccesses: number; toolFailures: number; tokensUsed: number }

export function extractCompactionLevel(events: ReadonlyArray<RunEvent>): string | null {
  for (const event of events) {
    if ((event.type as string) !== 'compaction.executed') continue
    const payload = event.payload as Record<string, unknown> | undefined
    const level = String(payload?.level ?? payload?.compaction_level ?? '')
    if (level) return level
  }
  return null
}

export function extractTokenBudget(events: ReadonlyArray<RunEvent>): RuntimeTokenBudget | undefined {
  // Token 预算来自后端事件事实源。
  //
  // UI 这里只做展示投影，不反向修改 runtime 上下文，也不在缺字段时补造状态。
  for (const event of events) {
    const payload = event.payload as Record<string, unknown> | undefined
    if (!payload) continue
    const usage = payload.usage as Record<string, unknown> | undefined
    const tokensUsed = payload.tokens_used ?? usage?.tokens_used
    if (typeof tokensUsed !== 'number') continue
    const rawMax = payload.tokens_max ?? payload.budget_max ?? usage?.max_tokens ?? 100000
    const max = typeof rawMax === 'number' ? rawMax : Number(rawMax) || 100000
    const rawStatus = payload.budget_status
    return {
      used: tokensUsed,
      max,
      status: normalizeBudgetStatus(typeof rawStatus === 'string' ? rawStatus : undefined, tokensUsed, max),
    }
  }
  return undefined
}

export function extractActiveSkills(
  events: ReadonlyArray<RunEvent>,
  agentState: AgentState | undefined,
): string[] | undefined {
  const skills = new Set<string>()
  for (const event of events) {
    const payload = event.payload as Record<string, unknown> | undefined
    const eventSkills = payload?.active_skills ?? payload?.skills
    if (Array.isArray(eventSkills)) {
      for (const skill of eventSkills) {
        if (typeof skill === 'string') skills.add(skill)
      }
    }
  }
  for (const skill of agentState?.activeSkills ?? []) skills.add(skill)
  return skills.size > 0 ? [...skills] : undefined
}

export function extractActiveMcpServers(
  events: ReadonlyArray<RunEvent>,
  agentState: AgentState | undefined,
): string[] | undefined {
  const servers = new Set<string>()
  for (const event of events) {
    const payload = event.payload as Record<string, unknown> | undefined
    const eventServers = payload?.active_mcp_servers ?? payload?.activeMcpServers ?? payload?.mcpServers
    if (Array.isArray(eventServers)) {
      for (const server of eventServers) {
        if (typeof server === 'string') servers.add(server)
      }
    }
  }
  for (const server of agentState?.activeMcpServers ?? []) servers.add(server)
  return servers.size > 0 ? [...servers] : undefined
}

export function extractRunStats(events: ReadonlyArray<RunEvent>): RuntimeRunStats | undefined {
  for (const event of events) {
    if (event.type !== 'run.completed') continue
    const payload = event.payload as Record<string, unknown> | undefined
    if (!payload) continue
    const attempts = payload.tool_attempts ?? payload.toolAttempts
    const successes = payload.tool_successes ?? payload.toolSuccesses
    const failures = payload.tool_failures ?? payload.toolFailures
    const tokensUsed = payload.tokens_used ?? payload.tokensUsed ?? payload.total_tokens ?? payload.totalTokens
    if (
      typeof attempts === 'number' ||
      typeof successes === 'number' ||
      typeof failures === 'number' ||
      typeof tokensUsed === 'number'
    ) {
      return {
        toolAttempts: Number(attempts ?? 0),
        toolSuccesses: Number(successes ?? 0),
        toolFailures: Number(failures ?? 0),
        tokensUsed: Number(tokensUsed ?? 0),
      }
    }
    const stats = payload.runtime_stats as Record<string, unknown> | undefined
    if (stats) {
      return {
        toolAttempts: Number(stats.tool_attempts ?? stats.toolAttempts ?? stats.tool_success_count ?? 0) + Number(stats.tool_failure_count ?? 0),
        toolSuccesses: Number(stats.tool_success_count ?? stats.toolSuccesses ?? 0),
        toolFailures: Number(stats.tool_failure_count ?? stats.toolFailures ?? 0),
        tokensUsed: Number(stats.tokens_used ?? stats.tokensUsed ?? 0),
      }
    }
  }
  return undefined
}

export function extractDenialCounts(agentState: AgentState | undefined): Record<string, number> | undefined {
  const value = (agentState as Record<string, unknown> | undefined)?.denialCounts
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const counts: Record<string, number> = {}
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === 'number') counts[key] = count
  }
  return Object.keys(counts).length ? counts : undefined
}

function normalizeBudgetStatus(status: string | undefined, used: number, max: number): RuntimeTokenBudget['status'] {
  if (status === 'normal' || status === 'warning' || status === 'critical' || status === 'exceeded') {
    return status
  }
  if (used > max) return 'exceeded'
  if (used > max * 0.9) return 'critical'
  if (used > max * 0.7) return 'warning'
  return 'normal'
}

export function buildAgentTodoItems(
  agentState: AgentState | undefined,
  agentWorkflow: AgentWorkflow | undefined,
): ProgressTodoItem[] {
  // Todo 面板只投影后端事实源。
  //
  // 优先使用 todo_write 写回的 AgentState.todos；如果计划模式只提交了
  // agentWorkflow，则把计划步骤作为只读任务清单展示，不额外发明进度。
  const rawTodos = agentState?.todos ?? []
  if (rawTodos.length) {
    return rawTodos
      .map((todo, index) => {
        const record = todo as typeof todo & Record<string, unknown>
        const content = String(record.title ?? record.content ?? `待办 ${index + 1}`)
        const activeForm = String(record.activeForm ?? record.active_form ?? record.description ?? content)
        return {
          id: String(record.todoId ?? record.todo_id ?? record.id ?? `todo:${index + 1}`),
          content,
          status: normalizeTodoStatus(String(record.status ?? 'pending')),
          activeForm,
        }
      })
      .filter((item) => item.content.trim())
  }

  const steps = agentWorkflow?.steps ?? []
  if (!steps.length) {
    return []
  }
  return steps.map((step, index) => ({
    id: step.stepId || `agent-workflow-step:${index + 1}`,
    content: step.title || step.reason || `工作流步骤 ${index + 1}`,
    status: normalizeTodoStatus(step.status),
    activeForm: step.toolName ? `正在执行 ${step.toolName}` : step.title,
  }))
}

function normalizeTodoStatus(status: string) {
  if (status === 'in_progress' || status === 'doing') return 'running'
  if (status === 'done') return 'completed'
  return status || 'pending'
}

export function buildProgressItems({
  runStatus,
  intent,
  agentWorkflow,
  artifacts,
  events,
}: {
  runStatus?: AnalysisRun['status']
  intent?: UserIntent
  agentWorkflow?: AgentWorkflow
  artifacts: ArtifactRef[]
  events: RunEvent[]
}) {
  const latestEvent = latestOperationalRunEvent(events)
  const completedToolEvents = events.filter(event => event.type === 'tool.completed')
  const latestCompletedToolEvent = completedToolEvents.at(-1)
  const hasToolActivity = completedToolEvents.length > 0 || events.some(event => event.type === 'tool.started')
  const hasWorkStarted = Boolean(latestEvent) || runStatus === 'running' || runStatus === 'completed'

  return [
    {
      id: 'understand',
      title: '理解需求',
      description:
        intent?.clarificationRequired
          ? '系统已经识别出问题，但还需要补充确认。'
          : intent
            ? '已识别本轮问题里的地点、对象和空间关系。'
            : hasToolActivity || runStatus === 'completed'
              ? '已理解本轮问题，并据此完成后续处理。'
              : '等待输入问题后开始整理分析意图。',
      status:
        runStatus === 'clarification_needed'
          ? ('warning' as const)
          : intent
            ? ('done' as const)
            : hasToolActivity || runStatus === 'completed'
              ? ('done' as const)
              : hasWorkStarted
                ? ('active' as const)
              : ('pending' as const),
    },
    {
      id: 'prepare',
      title: '准备数据',
      description:
        agentWorkflow?.steps.length
          ? `已经整理出 ${agentWorkflow.steps.length} 个分析步骤。`
          : hasToolActivity
            ? '已通过业务工具取得本轮所需数据。'
          : runStatus === 'completed' && !artifacts.length
            ? '本轮直接基于已有上下文完成回答。'
          : '会按当前目录、上传图层或外部来源准备数据。',
      status: agentWorkflow?.steps.length || hasToolActivity || runStatus === 'completed'
        ? ('done' as const)
        : hasWorkStarted
          ? ('active' as const)
          : ('pending' as const),
    },
    {
      id: 'analyze',
      title: '执行分析',
      description:
        runStatus === 'running'
          ? formatUiRunEventMessage(latestEvent)
          : runStatus === 'waiting_approval'
            ? '计划或受控动作正在等待确认，尚未继续执行。'
          : artifacts.length
            ? '空间分析已经完成，结果正在整理。'
            : runStatus === 'completed' && latestCompletedToolEvent
              ? formatUiRunEventMessage(latestCompletedToolEvent)
            : runStatus === 'completed'
              ? '本轮直接基于已有上下文完成回答。'
            : '需要空间计算时，会基于真实工具执行。',
      status:
        runStatus === 'running' || runStatus === 'waiting_approval'
          ? ('active' as const)
          : artifacts.length || runStatus === 'completed'
            ? ('done' as const)
            : runStatus === 'failed'
              ? ('warning' as const)
              : ('pending' as const),
    },
    {
      id: 'deliver',
      title: '交付结果',
      description:
        runStatus === 'completed'
          ? artifacts.length
            ? '结果图层、下载入口或文件产物已经生成。'
            : hasToolActivity
              ? '工具结果已整理为回答；本轮没有生成额外地图、文件或下载产物。'
              : '本轮回复已完成，没有生成地图、文件或下载产物。'
          : runStatus === 'waiting_approval'
            ? '待审批动作尚未执行；已有结果保持可见。'
          : runStatus === 'failed'
            ? '本次没有成功生成最终结果。'
            : '完成后会自动把结果高亮到地图上。',
      status:
        runStatus === 'completed'
          ? ('done' as const)
          : runStatus === 'waiting_approval'
            ? ('warning' as const)
          : runStatus === 'failed'
            ? ('warning' as const)
            : runStatus === 'running'
              ? ('active' as const)
              : ('pending' as const),
    },
  ] as const
}

export function formatUiRunEventMessage(event?: RunEvent) {
  if (!event) {
    return '系统正在自动处理你的问题。'
  }
  if (event.type === 'intent.parsed') {
    return '正在识别地点、范围和目标数据。'
  }
  if (event.type === 'plan.ready') {
    return '分析步骤已经确定，马上开始计算。'
  }
  if (event.type === 'artifact.created') {
    return '已经生成新的地图结果，正在加入地图。'
  }
  if (event.type === 'approval.required') {
    return '计划或受控动作正在等待审批，尚未执行。'
  }
  if (event.type === 'clarification.required') {
    return '需要你确认一个选项后继续。'
  }
  if (event.type === 'run.failed') {
    return '分析没有顺利完成，请稍后重试。'
  }
  return event.message
}

export function latestOperationalRunEvent(events: ReadonlyArray<RunEvent>): RunEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && event.type !== 'trace.recorded') return event
  }
  return undefined
}

export function describeCollectionGeometry(collection?: GeoJSON.FeatureCollection) {
  if (!collection?.features.length) {
    return '空图层'
  }
  const geometryTypes = Array.from(
    new Set(
      collection.features
        .map((feature) => feature.geometry?.type)
        .filter((value): value is NonNullable<GeoJSON.Geometry['type']> => Boolean(value)),
    ),
  )
  if (!geometryTypes.length) {
    return '未知几何'
  }
  return geometryTypes.join(' / ')
}

export function parseRasterCoordinates(value: unknown): [[number, number], [number, number], [number, number], [number, number]] | undefined {
  if (!Array.isArray(value) || value.length !== 4) {
    return undefined
  }
  const points = value.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) {
      return undefined
    }
    const lng = Number(point[0])
    const lat = Number(point[1])
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] as [number, number] : undefined
  })
  const [topLeft, topRight, bottomRight, bottomLeft] = points
  return topLeft && topRight && bottomRight && bottomLeft
    ? [topLeft, topRight, bottomRight, bottomLeft]
    : undefined
}

export function describeRasterMetadata(metadata: Record<string, unknown>) {
  const variable = typeof metadata.variable === 'string' ? metadata.variable : '气象栅格'
  const valueRange = Array.isArray(metadata.valueRange) ? metadata.valueRange.map(Number).filter(Number.isFinite) : []
  const [minimum, maximum] = valueRange
  if (minimum !== undefined && maximum !== undefined) {
    return `${variable} · ${minimum.toFixed(2)} - ${maximum.toFixed(2)}`
  }
  return variable
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 可视化编排器
//
//   文件:       AutomationStudio.tsx
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useMemo, useState, type SetStateAction } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Bot,
  Braces,
  ArrowUpRight,
  Check,
  CirclePlay,
  Copy,
  Download,
  FileCheck2,
  GitBranch,
  LayoutDashboard,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Square,
  Upload,
  Wrench,
  X,
} from 'lucide-react'
import {
  automationDefinitionSchema,
  type ToolDescriptor,
  type AutomationDefinition,
  type AutomationGraph,
  type AutomationNode,
  type AutomationNodeType,
  type AutomationRunRecord,
  type AutomationValidationResult,
} from '@geo-agent-platform/shared-types'
import type {
  StartAutomationPayload,
  AutomationDraftPayload,
  AutomationUpdatePayload,
} from '../../../api/client'
import { selectDesktopAutomationDraft } from '../../../api/desktopFiles'
import { requireDesktopBridge } from '../../../api/transport'
import { requestArtifactDownload } from '../../artifacts/desktopArtifactDownload'
import { AutomationNodeCard } from './AutomationNodeCard'
import { AutomationNodeInspector } from './AutomationNodeInspector'
import {
  createBlankAutomationGraph,
  createAutomationNode,
  flowToGraph,
  graphToFlow,
  layoutAutomationGraph,
  nextEdgeId,
  automationRunNavigationTarget,
  collectAutomationRunArtifacts,
  type StudioFlowEdge,
  type StudioFlowNode,
} from './automationStudioModel'

const NODE_TYPES = { automationNode: AutomationNodeCard }

export interface AutomationStudioProps {
  automations: AutomationDefinition[]
  validation: Record<string, AutomationValidationResult>
  tools: ToolDescriptor[]
  automationRuns: AutomationRunRecord[]
  isSubmitting: boolean
  onValidate: (payload: AutomationDraftPayload) => Promise<AutomationValidationResult>
  onCreate: (payload: AutomationDraftPayload) => Promise<AutomationDefinition>
  onUpdate: (payload: AutomationUpdatePayload) => Promise<AutomationDefinition>
  onPublish: (automationId: string, revision: number) => Promise<void>
  onDisable: (automationId: string) => Promise<void>
  onStart: (payload: StartAutomationPayload) => void
  onCancel: (automationRunId: string) => void
  onRespondApproval: (automationRunId: string, approvalId: string, decision: 'approved' | 'rejected') => Promise<void>
  onOpenAutomationRun: (sessionId: string, runId: string, threadId?: string) => void
}

interface EditorDraft {
  automationId: string | null
  sourceRevision: number | null
  name: string
  description: string
  version: string
  parametersSchemaText: string
  defaultParametersText: string
  timeoutSeconds: number
  outputType: string
  graph: AutomationGraph
}

export function AutomationStudio(props: AutomationStudioProps) {
  return <ReactFlowProvider><AutomationStudioInner {...props} /></ReactFlowProvider>
}

function AutomationStudioInner({
  automations,
  validation,
  tools,
  automationRuns,
  isSubmitting,
  onValidate,
  onCreate,
  onUpdate,
  onPublish,
  onDisable,
  onStart,
  onCancel,
  onRespondApproval,
  onOpenAutomationRun,
}: AutomationStudioProps) {
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null)
  const selectedDefinition = automations.find(item => item.automationId === selectedAutomationId)
    ?? (selectedAutomationId === null ? automations[0] ?? null : null)
  const effectiveSelectedAutomationId = selectedDefinition?.automationId ?? ''
  const definitionDraft = selectedDefinition ? draftFromDefinition(selectedDefinition) : newDraft()
  const [draftState, setDraftState] = useState<EditorDraft | null>(null)
  const draft = draftState ?? definitionDraft
  const setDraft = (next: SetStateAction<EditorDraft>) => {
    setDraftState(current => typeof next === 'function' ? next(current ?? draft) : next)
  }
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [definitionQuery, setDefinitionQuery] = useState('')
  const [toolQuery, setToolQuery] = useState('')
  const [dirty, setDirty] = useState(false)
  const [validationState, setValidationResult] = useState<AutomationValidationResult | null | undefined>(undefined)
  const validationResult = validationState === undefined
    ? selectedDefinition ? validation[selectedDefinition.automationId] ?? null : null
    : validationState
  const [editorMessage, setEditorMessage] = useState('')
  const [manualPrompt, setManualPrompt] = useState('')
  const [manualParameters, setManualParameters] = useState('{}')
  const [canvasDocumentVersion, setCanvasDocumentVersion] = useState(0)
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<StudioFlowNode, StudioFlowEdge> | null>(null)
  const readOnly = selectedDefinition?.source === 'builtin' && draft.automationId === selectedDefinition.automationId
  const flow = useMemo(() => graphToFlow(draft.graph, selectedNodeId), [draft.graph, selectedNodeId])
  const selectedNode = draft.graph.nodes.find(node => node.nodeId === selectedNodeId) ?? null
  const filteredDefinitions = useMemo(() => automations.filter(item => `${item.name} ${item.automationId}`.toLowerCase().includes(definitionQuery.trim().toLowerCase())), [definitionQuery, automations])
  const filteredTools = useMemo(() => tools.filter(item => item.available && `${item.label} ${item.name} ${item.group}`.toLowerCase().includes(toolQuery.trim().toLowerCase())), [toolQuery, tools])

  const updateGraph = (graph: AutomationGraph) => {
    setDraft(current => ({ ...current, graph }))
    setDirty(true)
    setValidationResult(null)
  }
  const updateNode = (nextNode: AutomationNode) => updateGraph({
    ...draft.graph,
    nodes: draft.graph.nodes.map(node => node.nodeId === nextNode.nodeId ? nextNode : node),
  })
  const addNode = (type: AutomationNodeType, tool?: ToolDescriptor, position?: { x: number; y: number }) => {
    if (readOnly || (type === 'trigger' && draft.graph.nodes.some(node => node.type === 'trigger'))) return
    const node = createAutomationNode(type, position ?? { x: 320 + draft.graph.nodes.length * 36, y: 120 + draft.graph.nodes.length * 22 }, tool)
    updateGraph({ ...draft.graph, entryNodeId: type === 'trigger' ? node.nodeId : draft.graph.entryNodeId, nodes: [...draft.graph.nodes, node] })
    setSelectedNodeId(node.nodeId)
  }
  const deleteNode = (nodeId: string) => {
    updateGraph({
      ...draft.graph,
      nodes: draft.graph.nodes.filter(node => node.nodeId !== nodeId),
      edges: draft.graph.edges.filter(edge => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId),
    })
    setSelectedNodeId(null)
  }
  const toPayload = (): AutomationDraftPayload => ({
    ...(draft.automationId ? { automationId: draft.automationId } : {}),
    name: draft.name.trim(),
    description: draft.description.trim(),
    version: draft.version.trim(),
    parametersSchema: parseObjectText(draft.parametersSchemaText, '参数 Schema'),
    defaultParameters: parseObjectText(draft.defaultParametersText, '默认参数'),
    timeoutSeconds: draft.timeoutSeconds,
    outputType: draft.outputType,
    graph: draft.graph,
  })

  const validateDraft = async () => {
    try {
      setEditorMessage('正在校验...')
      const result = await onValidate(toPayload())
      setValidationResult(result)
      setEditorMessage(result.valid ? '图结构、工具契约和参数 Schema 均通过校验。' : '校验发现需要修复的问题。')
      return result
    } catch (error) {
      setEditorMessage(errorMessage(error))
      return null
    }
  }
  const saveDraft = async () => {
    try {
      const result = await validateDraft()
      if (!result?.valid) return
      const payload = toPayload()
      const saved = draft.automationId && draft.sourceRevision
        ? await onUpdate({ ...payload, automationId: draft.automationId, expectedRevision: draft.sourceRevision })
        : await onCreate(payload)
      setSelectedAutomationId(saved.automationId)
      setDraft(draftFromDefinition(saved))
      setDirty(false)
      setEditorMessage(`草稿修订 ${saved.revision} 已保存。`)
    } catch (error) {
      setEditorMessage(errorMessage(error))
    }
  }
  const publishDraft = async () => {
    try {
      if (!draft.automationId || !draft.sourceRevision || dirty) {
        setEditorMessage('发布前请先保存当前草稿。')
        return
      }
      const result = await validateDraft()
      if (!result?.valid) return
      await onPublish(draft.automationId, draft.sourceRevision)
      setEditorMessage(`修订 ${draft.sourceRevision} 已发布。`)
    } catch (error) {
      setEditorMessage(errorMessage(error))
    }
  }
  const selectDefinition = async (definition: AutomationDefinition) => {
    if (dirty) {
      const confirmed = await requireDesktopBridge().dialog.confirm({
        title: '切换自动化流程',
        message: '当前更改尚未保存，是否继续切换？',
        detail: '继续后，当前草稿中尚未保存的更改将被丢弃。',
        confirmLabel: '继续切换',
        cancelLabel: '留在此处',
        tone: 'warning',
      })
      if (!confirmed) return
    }
    setDirty(false)
    setSelectedAutomationId(definition.automationId)
    setDraft(draftFromDefinition(definition))
    setValidationResult(validation[definition.automationId] ?? null)
    setSelectedNodeId(null)
    setCanvasDocumentVersion(current => current + 1)
  }

  return (
    <div className="automation-studio">
      <header className="automation-studio__topbar">
        <div>
          <span>自动化流程编排</span>
          <strong>{draft.name || '未命名自动化流程'}</strong>
          <small>{dirty ? '有未保存更改' : draft.automationId ? `修订 ${draft.sourceRevision ?? 1}` : '新草稿'}</small>
        </div>
        <div className="automation-studio__toolbar">
          <button type="button" title="新建自动化流程" onClick={() => { setSelectedAutomationId(''); setDraft(newDraft()); setValidationResult(null); setDirty(true); setSelectedNodeId(null); setCanvasDocumentVersion(current => current + 1) }}><Plus size={16} /><span>新建</span></button>
          <button type="button" title="复制为工作区草稿" disabled={!selectedDefinition} onClick={() => { if (!selectedDefinition) return; setSelectedAutomationId(''); setDraft({ ...draftFromDefinition(selectedDefinition), automationId: null, sourceRevision: null, name: `${selectedDefinition.name} 副本` }); setValidationResult(null); setDirty(true); setSelectedNodeId(null); setCanvasDocumentVersion(current => current + 1) }}><Copy size={16} /><span>复制</span></button>
          <button type="button" title="自动布局" disabled={readOnly} onClick={() => updateGraph(layoutAutomationGraph(draft.graph))}><LayoutDashboard size={16} /><span>布局</span></button>
          <button
            type="button"
            title="导入 JSON"
            disabled={readOnly}
            onClick={() => {
              void importDraft(
                setDraft,
                setDirty,
                setEditorMessage,
                () => setCanvasDocumentVersion(current => current + 1),
              )
            }}
          >
            <Upload size={16} /><span>导入</span>
          </button>
          <button type="button" title="导出 JSON" onClick={() => exportDraft(draft)}><Download size={16} /><span>导出</span></button>
          <button type="button" title="服务端校验" onClick={() => { void validateDraft() }}><FileCheck2 size={16} /><span>校验</span></button>
          <button type="button" className="is-primary" title="保存新修订" disabled={readOnly || isSubmitting} onClick={() => { void saveDraft() }}><Save size={16} /><span>保存</span></button>
          <button type="button" className="is-publish" title="发布当前修订" disabled={readOnly || isSubmitting || dirty || !draft.automationId} onClick={() => { void publishDraft() }}><Check size={16} /><span>发布</span></button>
        </div>
      </header>

      <div className="automation-studio__body">
        <aside className="automation-palette">
          <section>
            <h3>自动化流程</h3>
            <label className="automation-search"><Search size={14} /><input value={definitionQuery} placeholder="搜索定义" onChange={event => setDefinitionQuery(event.target.value)} /></label>
            <div className="automation-definition-list">
              {filteredDefinitions.map(definition => (
                <button type="button" className={definition.automationId === effectiveSelectedAutomationId ? 'is-active' : ''} key={definition.automationId} onClick={() => void selectDefinition(definition)}>
                  <strong>{definition.name}</strong><span>{definition.source === 'builtin' ? '内置' : `r${definition.revision}`} · {lifecycleLabel(definition.lifecycle)}</span>
                </button>
              ))}
            </div>
          </section>
          <section>
            <h3>控制节点</h3>
            <div className="automation-palette__grid">
              <PaletteButton icon={Bot} label="智能体" disabled={readOnly} onAdd={() => addNode('agent')} />
              <PaletteButton icon={GitBranch} label="条件" disabled={readOnly} onAdd={() => addNode('condition')} />
              <PaletteButton icon={ShieldCheck} label="审批" disabled={readOnly} onAdd={() => addNode('approval')} />
              <PaletteButton icon={Braces} label="输出" disabled={readOnly} onAdd={() => addNode('output')} />
            </div>
          </section>
          <section>
            <h3>工具节点</h3>
            <label className="automation-search"><Search size={14} /><input value={toolQuery} placeholder="搜索工具" onChange={event => setToolQuery(event.target.value)} /></label>
            <div className="automation-tool-list">
              {filteredTools.map(tool => (
                <button type="button" draggable={!readOnly} disabled={readOnly} key={tool.name} onDragStart={event => { event.dataTransfer.setData('application/x-automation-tool', tool.name); event.dataTransfer.effectAllowed = 'copy' }} onClick={() => addNode('tool', tool)}>
                  <Wrench size={14} /><span><strong>{tool.label}</strong><small>{tool.group} · {tool.description}</small></span>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <main className="automation-canvas" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => {
          event.preventDefault()
          if (readOnly || !flowInstance) return
          const toolName = event.dataTransfer.getData('application/x-automation-tool')
          const tool = tools.find(item => item.name === toolName)
          if (!tool) return
          addNode('tool', tool, flowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
        }}>
          <ReactFlow<StudioFlowNode, StudioFlowEdge>
            key={`${selectedDefinition?.automationId ?? 'workspace-draft'}:${canvasDocumentVersion}`}
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={NODE_TYPES}
            fitView
            minZoom={0.25}
            maxZoom={1.75}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable
            onInit={setFlowInstance}
            onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            onNodesChange={changes => {
              if (readOnly) return
              const positions = new Map(changes.flatMap(change => (
                change.type === 'position' && change.position
                  ? [[change.id, change.position] as const]
                  : []
              )))
              if (positions.size === 0) return
              updateGraph({
                ...draft.graph,
                nodes: draft.graph.nodes.map(node => {
                  const position = positions.get(node.nodeId)
                  return position ? { ...node, position } : node
                }),
              })
            }}
            onNodesDelete={deletedNodes => {
              if (readOnly || deletedNodes.length === 0) return
              const deletedIds = new Set(deletedNodes.map(node => node.id))
              updateGraph({
                ...draft.graph,
                nodes: draft.graph.nodes.filter(node => !deletedIds.has(node.nodeId)),
                edges: draft.graph.edges.filter(edge => !deletedIds.has(edge.sourceNodeId) && !deletedIds.has(edge.targetNodeId)),
              })
              if (selectedNodeId && deletedIds.has(selectedNodeId)) setSelectedNodeId(null)
            }}
            onEdgesDelete={deletedEdges => {
              if (readOnly || deletedEdges.length === 0) return
              const deletedIds = new Set(deletedEdges.map(edge => edge.id))
              updateGraph({
                ...draft.graph,
                edges: draft.graph.edges.filter(edge => !deletedIds.has(edge.edgeId)),
              })
            }}
            isValidConnection={connection => validConnection(connection, draft.graph)}
            onConnect={connection => {
              if (readOnly || !connection.source || !connection.target) return
              const edge: StudioFlowEdge = {
                id: nextEdgeId(connection.source, connection.target),
                source: connection.source,
                target: connection.target,
                sourceHandle: connection.sourceHandle,
                targetHandle: connection.targetHandle,
                type: 'smoothstep',
                data: { sourcePort: normalizeConnectionPort(connection.sourceHandle) },
              }
              updateGraph(flowToGraph(draft.graph, flow.nodes, [...flow.edges, edge]))
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeStrokeWidth={2} />
          </ReactFlow>
          {readOnly ? <div className="automation-canvas__readonly">内置自动化流程为只读。点击“复制”后可编辑。</div> : null}
        </main>

        <AutomationNodeInspector node={selectedNode} graph={draft.graph} tools={tools} readOnly={readOnly} onChange={updateNode} onDelete={deleteNode} />
      </div>

      <section className="automation-studio__settings">
        <div className="automation-definition-form">
          <label><span>名称</span><input disabled={readOnly} value={draft.name} onChange={event => { setDraft(current => ({ ...current, name: event.target.value })); setDirty(true) }} /></label>
          <label><span>版本</span><input disabled={readOnly} value={draft.version} onChange={event => { setDraft(current => ({ ...current, version: event.target.value })); setDirty(true) }} /></label>
          <label><span>超时秒数</span><input disabled={readOnly} type="number" min={30} max={86400} value={draft.timeoutSeconds} onChange={event => { setDraft(current => ({ ...current, timeoutSeconds: Number(event.target.value) })); setDirty(true) }} /></label>
          <label className="is-wide"><span>说明</span><input disabled={readOnly} value={draft.description} onChange={event => { setDraft(current => ({ ...current, description: event.target.value })); setDirty(true) }} /></label>
          <label className="is-wide"><span>参数 JSON Schema</span><textarea disabled={readOnly} value={draft.parametersSchemaText} onChange={event => { setDraft(current => ({ ...current, parametersSchemaText: event.target.value })); setDirty(true) }} /></label>
          <label className="is-wide"><span>默认参数</span><textarea disabled={readOnly} value={draft.defaultParametersText} onChange={event => { setDraft(current => ({ ...current, defaultParametersText: event.target.value })); setDirty(true) }} /></label>
        </div>
        <ValidationPanel result={validationResult} message={editorMessage} />
      </section>

      <AutomationRunPanel
        automations={automations}
        selectedAutomationId={effectiveSelectedAutomationId}
        runs={automationRuns}
        prompt={manualPrompt}
        parameters={manualParameters}
        isSubmitting={isSubmitting}
        onPromptChange={setManualPrompt}
        onParametersChange={setManualParameters}
        onStart={() => {
          if (!effectiveSelectedAutomationId) return
          try { onStart({ automationId: effectiveSelectedAutomationId, prompt: manualPrompt.trim(), parameters: parseObjectText(manualParameters, '运行参数') }) }
          catch (error) { setEditorMessage(errorMessage(error)) }
        }}
        onCancel={onCancel}
        onRespondApproval={onRespondApproval}
        onOpenAutomationRun={onOpenAutomationRun}
        onDisable={async () => { if (selectedDefinition?.source === 'workspace') await onDisable(selectedDefinition.automationId) }}
      />
    </div>
  )
}

function AutomationRunPanel({ automations, selectedAutomationId, runs, prompt, parameters, isSubmitting, onPromptChange, onParametersChange, onStart, onCancel, onRespondApproval, onOpenAutomationRun, onDisable }: {
  automations: AutomationDefinition[]
  selectedAutomationId: string
  runs: AutomationRunRecord[]
  prompt: string
  parameters: string
  isSubmitting: boolean
  onPromptChange: (value: string) => void
  onParametersChange: (value: string) => void
  onStart: () => void
  onCancel: (automationRunId: string) => void
  onRespondApproval: AutomationStudioProps['onRespondApproval']
  onOpenAutomationRun: AutomationStudioProps['onOpenAutomationRun']
  onDisable: () => Promise<void>
}) {
  const definition = automations.find(item => item.automationId === selectedAutomationId)
  const relatedRuns = runs.filter(run => !selectedAutomationId || run.automationId === selectedAutomationId).slice(0, 10)
  return (
    <section className="automation-runs">
      <div className="automation-run-launcher">
        <header><div><span>试运行</span><strong>{definition?.name ?? '选择自动化流程'}</strong></div>{definition?.source === 'workspace' ? <button type="button" onClick={() => { void onDisable() }}><X size={14} />停用</button> : null}</header>
        <textarea value={prompt} placeholder="描述本次运行目标。" onChange={event => onPromptChange(event.target.value)} />
        <label><span>运行参数 JSON</span><textarea value={parameters} onChange={event => onParametersChange(event.target.value)} /></label>
        <button type="button" className="automation-run-launcher__start" disabled={!definition?.enabled || definition.publishedRevision === null || !prompt.trim() || isSubmitting} onClick={onStart}><CirclePlay size={16} />启动自动化流程</button>
      </div>
      <div className="automation-run-history">
        <header><span>最近运行</span><strong>{relatedRuns.length}</strong></header>
        {relatedRuns.map(run => <AutomationRunCard
          key={run.automationRunId}
          run={run}
          automationName={automations.find(item => item.automationId === run.automationId)?.name ?? run.automationId}
          onCancel={onCancel}
          onRespondApproval={onRespondApproval}
          onOpenAutomationRun={onOpenAutomationRun}
        />)}
        {!relatedRuns.length ? <p className="automation-runs__empty">暂无运行记录。</p> : null}
      </div>
    </section>
  )
}

function AutomationRunCard({ run, automationName, onCancel, onRespondApproval, onOpenAutomationRun }: {
  run: AutomationRunRecord
  automationName: string
  onCancel: AutomationStudioProps['onCancel']
  onRespondApproval: AutomationStudioProps['onRespondApproval']
  onOpenAutomationRun: AutomationStudioProps['onOpenAutomationRun']
}) {
  const [downloadingArtifactId, setDownloadingArtifactId] = useState<string | null>(null)
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null)
  const navigationTarget = automationRunNavigationTarget(run)
  const artifacts = collectAutomationRunArtifacts(run)
  const answer = typeof run.outputs.answer === 'string' && run.outputs.answer.trim()
    ? run.outputs.answer.trim()
    : null
  const additionalOutputs = Object.entries(run.outputs).filter(([name]) => name !== 'answer' && name !== 'artifacts')
  const downloadArtifact = async (artifact: (typeof artifacts)[number]) => {
    if (downloadingArtifactId) return
    setDownloadingArtifactId(artifact.artifactId)
    setDownloadMessage(null)
    try {
      const download = await requestArtifactDownload(artifact)
      setDownloadMessage(
        download.canceled
          ? '已取消保存。'
          : `已保存 ${download.displayName ?? '交付物'}。`,
      )
    } catch (error) {
      setDownloadMessage(downloadErrorMessage(error))
    } finally {
      setDownloadingArtifactId(null)
    }
  }
  return (
    <article className="automation-run-card">
      <div className="automation-run-card__header">
        <div title={run.automationRunId}><strong>{automationName}</strong><span>r{run.automationRevision} · {statusLabel(run.status)} · {formatDateTime(run.startedAt)}</span></div>
        <div className="automation-run-card__actions">
          {navigationTarget ? <button type="button" className="is-open" onClick={() => onOpenAutomationRun(navigationTarget.sessionId, navigationTarget.runId, navigationTarget.threadId ?? undefined)}><ArrowUpRight size={14} />打开交付运行</button> : null}
          {['queued', 'running', 'waiting_approval'].includes(run.status) ? <button type="button" className="is-cancel" aria-label="取消运行" onClick={() => onCancel(run.automationRunId)}><Square size={14} /></button> : null}
        </div>
      </div>
      <div className="automation-run-card__steps">
        {run.nodeRuns.map(node => <span className={`is-${node.status}`} key={node.nodeId}><i />{node.label}<small>{node.status}</small></span>)}
      </div>
      {run.pendingApproval?.status === 'pending' ? (
        <div className="automation-run-card__approval"><strong>{run.pendingApproval.title}</strong><p>{run.pendingApproval.question}</p><div><button type="button" className="is-reject" onClick={() => { void onRespondApproval(run.automationRunId, run.pendingApproval!.approvalId, 'rejected') }}>拒绝</button><button type="button" className="is-approve" onClick={() => { void onRespondApproval(run.automationRunId, run.pendingApproval!.approvalId, 'approved') }}>批准并继续</button></div></div>
      ) : null}
      {answer || additionalOutputs.length ? (
        <section className="automation-run-card__outputs" aria-label="自动化流程输出">
          {answer ? <div className="automation-run-card__answer"><span>最终结论</span><p>{answer}</p></div> : null}
          {additionalOutputs.length ? <dl>{additionalOutputs.map(([name, value]) => <div key={name}><dt>{name}</dt><dd><pre>{formatAutomationOutput(value)}</pre></dd></div>)}</dl> : null}
        </section>
      ) : null}
      {artifacts.length ? (
        <section className="automation-run-card__artifacts" aria-label="可核验交付物">
          <span>可核验交付物 · {artifacts.length}</span>
          <div>{artifacts.map(artifact => (
            <button
              key={artifact.artifactId}
              type="button"
              disabled={downloadingArtifactId !== null}
              onClick={() => {
                void downloadArtifact(artifact)
              }}
            >
              <Download size={14} />
              <strong>
                {downloadingArtifactId === artifact.artifactId ? '正在保存…' : artifact.name}
              </strong>
              <small>{artifact.artifactType}</small>
            </button>
          ))}</div>
        </section>
      ) : null}
      {downloadMessage ? (
        <p className="automation-run-card__download-status" role="status">{downloadMessage}</p>
      ) : null}
      {run.errorMessage ? <p className="automation-run-card__error">{run.errorMessage}</p> : null}
    </article>
  )
}

function downloadErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : '交付物下载失败，请查看系统日志。'
}

function ValidationPanel({ result, message }: { result: AutomationValidationResult | null; message: string }) {
  return (
    <aside className="automation-validation">
      <header><span>编译校验</span><strong>{result ? result.valid ? '通过' : `${result.issues.filter(issue => issue.severity === 'error').length} 个错误` : '尚未校验'}</strong></header>
      {message ? <p>{message}</p> : null}
      {result?.issues.map((issue, index) => <div className={`automation-validation__issue is-${issue.severity}`} key={`${issue.code}:${issue.nodeId ?? issue.edgeId ?? index}`}><span>{issue.severity === 'error' ? '错误' : '提醒'}</span><p>{issue.message}</p></div>)}
      {result?.valid ? <div className="automation-validation__success"><Check size={15} />执行顺序：{result.topologicalOrder.join(' → ')}</div> : null}
    </aside>
  )
}

function PaletteButton({ icon: Icon, label, disabled, onAdd }: { icon: typeof Bot; label: string; disabled: boolean; onAdd: () => void }) {
  return <button type="button" disabled={disabled} onClick={onAdd}><Icon size={15} /><span>{label}</span></button>
}

function draftFromDefinition(definition: AutomationDefinition): EditorDraft {
  return {
    automationId: definition.automationId,
    sourceRevision: definition.revision,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    parametersSchemaText: JSON.stringify(definition.parametersSchema, null, 2),
    defaultParametersText: JSON.stringify(definition.defaultParameters, null, 2),
    timeoutSeconds: definition.timeoutSeconds,
    outputType: definition.outputType,
    graph: structuredClone(definition.graph),
  }
}

function newDraft(): EditorDraft {
  return {
    automationId: null,
    sourceRevision: null,
    name: '新建工具流',
    description: '使用可审计工具节点完成一项业务流程。',
    version: '1.0.0',
    parametersSchemaText: JSON.stringify({ type: 'object', properties: {}, additionalProperties: false }, null, 2),
    defaultParametersText: '{}',
    timeoutSeconds: 900,
    outputType: 'conversation',
    graph: createBlankAutomationGraph(),
  }
}

function validConnection(connection: Connection | StudioFlowEdge, graph: AutomationGraph): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) return false
  const source = graph.nodes.find(node => node.nodeId === connection.source)
  const target = graph.nodes.find(node => node.nodeId === connection.target)
  if (!source || !target || source.type === 'output' || target.type === 'trigger') return false
  const port = connection.sourceHandle ?? 'default'
  return !graph.edges.some(edge => edge.sourceNodeId === source.nodeId && edge.sourcePort === port)
}

function normalizeConnectionPort(value: string | null | undefined): 'default' | 'success' | 'error' | 'true' | 'false' | 'approved' | 'rejected' {
  return value === 'success' || value === 'error' || value === 'true' || value === 'false' || value === 'approved' || value === 'rejected'
    ? value
    : 'default'
}

function parseObjectText(value: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error(`${label}不是有效 JSON。`) }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON object。`)
  return parsed as Record<string, unknown>
}

function exportDraft(draft: EditorDraft): void {
  const content = JSON.stringify({
    automationId: draft.automationId ?? 'workspace_automation', name: draft.name, description: draft.description,
    version: draft.version, revision: draft.sourceRevision ?? 1, publishedRevision: null, source: 'workspace', lifecycle: 'draft',
    workspaceId: null, createdByUserId: null, enabled: true,
    parametersSchema: parseObjectText(draft.parametersSchemaText, '参数 Schema'),
    defaultParameters: parseObjectText(draft.defaultParametersText, '默认参数'),
    requiredTools: [], requiresApproval: draft.graph.nodes.some(node => node.type === 'approval'),
    timeoutSeconds: draft.timeoutSeconds, outputType: draft.outputType, graph: draft.graph,
    createdAt: null, updatedAt: null,
  }, null, 2)
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = `${safeFilename(draft.name)}.automation.json`; link.click(); URL.revokeObjectURL(url)
}

async function importDraft(
  setDraft: (draft: EditorDraft) => void,
  setDirty: (dirty: boolean) => void,
  setMessage: (message: string) => void,
  onImported: () => void,
): Promise<void> {
  try {
    const selected = await selectDesktopAutomationDraft()
    if (!selected) return
    const parsed = automationDefinitionSchema.parse(JSON.parse(selected.text))
    setDraft({ ...draftFromDefinition(parsed), automationId: null, sourceRevision: null })
    setDirty(true)
    onImported()
    setMessage('自动化流程 JSON 已导入为新草稿，请校验后保存。')
  } catch (error) { setMessage(`导入失败：${errorMessage(error)}`) }
}

function lifecycleLabel(value: AutomationDefinition['lifecycle']): string {
  return value === 'published' ? '已发布' : value === 'draft' ? '草稿' : '已停用'
}

function statusLabel(value: AutomationRunRecord['status']): string {
  if (value === 'queued') return '排队中'; if (value === 'running') return '运行中'; if (value === 'waiting_approval') return '等待审批'
  if (value === 'completed') return '已完成'; if (value === 'cancelled') return '已取消'; return '失败'
}

function formatAutomationOutput(value: unknown): string {
  const formatted = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const safeValue = formatted ?? String(value)
  return safeValue.length > 1_600 ? `${safeValue.slice(0, 1_600)}\n…` : safeValue
}

function formatDateTime(value: string): string { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
function safeFilename(value: string): string { return value.replace(/[<>:"/\\|?*]+/gu, '_').trim() || 'automation' }
function errorMessage(error: unknown): string { return error instanceof Error && error.message.trim() ? error.message : '操作失败。' }

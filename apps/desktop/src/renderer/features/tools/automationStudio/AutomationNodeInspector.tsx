// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 节点配置面板
//
//   文件:       AutomationNodeInspector.tsx
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Plus, Trash2 } from 'lucide-react'
import type {
  ToolDescriptor,
  AutomationBinding,
  AutomationGraph,
  AutomationNode,
} from '@geo-agent-platform/shared-types'

export interface AutomationNodeInspectorProps {
  node: AutomationNode | null
  graph: AutomationGraph
  tools: ToolDescriptor[]
  readOnly: boolean
  onChange: (node: AutomationNode) => void
  onDelete: (nodeId: string) => void
}

export function AutomationNodeInspector({ node, graph, tools, readOnly, onChange, onDelete }: AutomationNodeInspectorProps) {
  if (!node) {
    return (
      <aside className="automation-inspector">
        <header><span>节点配置</span><strong>未选择节点</strong></header>
        <p className="automation-inspector__empty">在画布中选择节点后，可在这里配置输入、重试、审批和输出绑定。</p>
      </aside>
    )
  }
  const patch = (updates: Partial<AutomationNode>) => onChange({ ...node, ...updates } as AutomationNode)
  return (
    <aside className="automation-inspector">
      <header>
        <span>节点配置</span>
        <strong>{node.label}</strong>
      </header>
      <div className="automation-inspector__body">
        <InspectorField label="名称">
          <input disabled={readOnly} value={node.label} onChange={event => patch({ label: event.target.value })} />
        </InspectorField>
        <InspectorField label="说明">
          <textarea disabled={readOnly} value={node.description} onChange={event => patch({ description: event.target.value })} />
        </InspectorField>
        {node.type === 'tool' ? (
          <ToolNodeFields node={node} tools={tools} graph={graph} readOnly={readOnly} onChange={onChange} />
        ) : null}
        {node.type === 'agent' ? (
          <>
            <InspectorField label="提示词模板" hint="使用 {{{input.prompt}}}、{{input.parameters.xxx}} 或 {{{nodes.nodeId.json}}}">
              <textarea className="automation-inspector__prompt" disabled={readOnly} value={node.config.promptTemplate} onChange={event => onChange({ ...node, config: { ...node.config, promptTemplate: event.target.value } })} />
            </InspectorField>
            <div className="automation-inspector__grid">
              <InspectorField label="执行模式">
                <select disabled={readOnly} value={node.config.executionMode} onChange={event => onChange({ ...node, config: { ...node.config, executionMode: event.target.value as 'auto' | 'plan' } })}>
                  <option value="auto">自动执行</option><option value="plan">计划模式</option>
                </select>
              </InspectorField>
              <InspectorField label="推理">
                <select disabled={readOnly} value={node.config.reasoning ? 'on' : 'off'} onChange={event => onChange({ ...node, config: { ...node.config, reasoning: event.target.value === 'on' } })}>
                  <option value="on">启用</option><option value="off">关闭</option>
                </select>
              </InspectorField>
            </div>
            <RetryFields readOnly={readOnly} retry={node.config.retry} onChange={retry => onChange({ ...node, config: { ...node.config, retry } })} />
          </>
        ) : null}
        {node.type === 'condition' ? (
          <>
            <BindingEditor label="左值" value={node.config.left} graph={graph} nodeId={node.nodeId} readOnly={readOnly} onChange={left => onChange({ ...node, config: { ...node.config, left } })} />
            <InspectorField label="比较方式">
              <select disabled={readOnly} value={node.config.operator} onChange={event => onChange({ ...node, config: { ...node.config, operator: event.target.value as typeof node.config.operator } })}>
                <option value="equals">等于</option><option value="not_equals">不等于</option>
                <option value="greater_than">大于</option><option value="greater_or_equal">大于等于</option>
                <option value="less_than">小于</option><option value="less_or_equal">小于等于</option>
                <option value="contains">包含</option><option value="exists">存在</option><option value="is_true">为真</option>
              </select>
            </InspectorField>
            {!['exists', 'is_true'].includes(node.config.operator) ? (
              <BindingEditor label="右值" value={node.config.right ?? { source: 'literal', value: '' }} graph={graph} nodeId={node.nodeId} readOnly={readOnly} onChange={right => onChange({ ...node, config: { ...node.config, right } })} />
            ) : null}
          </>
        ) : null}
        {node.type === 'approval' ? (
          <>
            <InspectorField label="审批标题"><input disabled={readOnly} value={node.config.title} onChange={event => onChange({ ...node, config: { ...node.config, title: event.target.value } })} /></InspectorField>
            <InspectorField label="审批问题"><textarea disabled={readOnly} value={node.config.question} onChange={event => onChange({ ...node, config: { ...node.config, question: event.target.value } })} /></InspectorField>
            <InspectorField label="风险说明"><textarea disabled={readOnly} value={node.config.description} onChange={event => onChange({ ...node, config: { ...node.config, description: event.target.value } })} /></InspectorField>
          </>
        ) : null}
        {node.type === 'output' ? (
          <OutputFields node={node} graph={graph} readOnly={readOnly} onChange={onChange} />
        ) : null}
      </div>
      {node.type !== 'trigger' && !readOnly ? (
        <button type="button" className="automation-inspector__delete" onClick={() => onDelete(node.nodeId)}>
          <Trash2 size={15} aria-hidden="true" /> 删除节点
        </button>
      ) : null}
    </aside>
  )
}

function ToolNodeFields({ node, tools, graph, readOnly, onChange }: {
  node: Extract<AutomationNode, { type: 'tool' }>
  tools: ToolDescriptor[]
  graph: AutomationGraph
  readOnly: boolean
  onChange: (node: AutomationNode) => void
}) {
  const tool = tools.find(item => item.name === node.config.toolName)
  return (
    <>
      <InspectorField label="工具">
        <select disabled={readOnly} value={node.config.toolName} onChange={event => {
          const selected = tools.find(item => item.name === event.target.value)
          if (!selected) return
          onChange({
            ...node,
            label: selected.label,
            config: {
              ...node.config,
              toolName: selected.name,
              arguments: Object.fromEntries(selected.parameters.filter(parameter => parameter.required).map(parameter => [
                parameter.key,
                { source: 'literal' as const, value: parameter.defaultValue ?? '' },
              ])),
            },
          })
        }}>
          {tools.filter(item => item.available).map(item => <option key={item.name} value={item.name}>{item.group} · {item.label}</option>)}
        </select>
      </InspectorField>
      <InspectorField label="审批策略">
        <select disabled={readOnly} value={node.config.approvalMode} onChange={event => onChange({ ...node, config: { ...node.config, approvalMode: event.target.value as 'auto' | 'always' } })}>
          <option value="auto">按工具安全声明</option><option value="always">每次都审批</option>
        </select>
      </InspectorField>
      <RetryFields readOnly={readOnly} retry={node.config.retry} onChange={retry => onChange({ ...node, config: { ...node.config, retry } })} />
      <div className="automation-inspector__section-title">参数绑定</div>
      {tool?.parameters.map(parameter => {
        const binding = node.config.arguments[parameter.key]
        return binding ? (
          <div className="automation-argument" key={parameter.key}>
            <div className="automation-argument__header"><strong>{parameter.label}</strong><span>{parameter.required ? '必填' : '可选'}</span></div>
            <BindingEditor value={binding} graph={graph} nodeId={node.nodeId} readOnly={readOnly} onChange={value => onChange({ ...node, config: { ...node.config, arguments: { ...node.config.arguments, [parameter.key]: value } } })} />
            {!parameter.required && !readOnly ? <button type="button" onClick={() => {
              const args = { ...node.config.arguments }; delete args[parameter.key]
              onChange({ ...node, config: { ...node.config, arguments: args } })
            }}>移除参数</button> : null}
          </div>
        ) : !readOnly ? (
          <button type="button" className="automation-inspector__add" key={parameter.key} onClick={() => onChange({ ...node, config: { ...node.config, arguments: { ...node.config.arguments, [parameter.key]: { source: 'literal', value: parameter.defaultValue ?? '' } } } })}>
            <Plus size={14} aria-hidden="true" /> 添加 {parameter.label}
          </button>
        ) : null
      })}
      {!tool ? <p className="automation-inspector__warning">工具目录中不存在该工具，发布校验将失败。</p> : null}
    </>
  )
}

function OutputFields({ node, graph, readOnly, onChange }: {
  node: Extract<AutomationNode, { type: 'output' }>
  graph: AutomationGraph
  readOnly: boolean
  onChange: (node: AutomationNode) => void
}) {
  return (
    <>
      <div className="automation-inspector__section-title">输出字段</div>
      {Object.entries(node.config.outputs).map(([name, binding]) => (
        <div className="automation-output-binding" key={name}>
          <input disabled={readOnly} value={name} aria-label="输出字段名" onChange={event => {
            const outputs = { ...node.config.outputs }; delete outputs[name]; outputs[event.target.value] = binding
            onChange({ ...node, config: { outputs } })
          }} />
          <BindingEditor value={binding} graph={graph} nodeId={node.nodeId} readOnly={readOnly} onChange={value => onChange({ ...node, config: { outputs: { ...node.config.outputs, [name]: value } } })} />
          {!readOnly ? <button type="button" aria-label={`删除输出 ${name}`} onClick={() => {
            const outputs = { ...node.config.outputs }; delete outputs[name]
            onChange({ ...node, config: { outputs } })
          }}><Trash2 size={14} /></button> : null}
        </div>
      ))}
      {!readOnly ? <button type="button" className="automation-inspector__add" onClick={() => {
        const key = uniqueOutputName(node.config.outputs)
        onChange({ ...node, config: { outputs: { ...node.config.outputs, [key]: { source: 'input', path: 'prompt' } } } })
      }}><Plus size={14} aria-hidden="true" /> 添加输出</button> : null}
    </>
  )
}

function BindingEditor({ label, value, graph, nodeId, readOnly, onChange }: {
  label?: string
  value: AutomationBinding
  graph: AutomationGraph
  nodeId: string
  readOnly: boolean
  onChange: (value: AutomationBinding) => void
}) {
  const upstreamNodes = graph.nodes.filter(node => node.nodeId !== nodeId && node.type !== 'output')
  return (
    <div className="automation-binding">
      {label ? <span>{label}</span> : null}
      <select disabled={readOnly} value={value.source} onChange={event => {
        const source = event.target.value
        if (source === 'literal') onChange({ source, value: '' })
        else if (source === 'input') onChange({ source, path: 'parameters.value' })
        else if (source === 'value_ref') onChange({ source, nodeId: upstreamNodes[0]?.nodeId ?? '', kind: '', path: 'refId' })
        else onChange({ source: 'node', nodeId: upstreamNodes[0]?.nodeId ?? '', path: 'payload' })
      }}>
        <option value="literal">固定值</option><option value="input">运行输入</option><option value="node">上游节点字段</option><option value="value_ref">上游值引用</option>
      </select>
      {value.source === 'literal' ? <input disabled={readOnly} value={formatLiteral(value.value)} onChange={event => onChange({ source: 'literal', value: parseLiteral(event.target.value) })} /> : null}
      {value.source === 'input' ? <input disabled={readOnly} value={value.path} placeholder="parameters.datasetId" onChange={event => onChange({ ...value, path: event.target.value })} /> : null}
      {value.source === 'node' ? (
        <>
          <select disabled={readOnly} value={value.nodeId} onChange={event => onChange({ ...value, nodeId: event.target.value })}>
            {upstreamNodes.map(node => <option key={node.nodeId} value={node.nodeId}>{node.label}</option>)}
          </select>
          <input disabled={readOnly} value={value.path} placeholder="valueRefs.0.refId" onChange={event => onChange({ ...value, path: event.target.value })} />
        </>
      ) : null}
      {value.source === 'value_ref' ? (
        <>
          <select disabled={readOnly} value={value.nodeId} onChange={event => onChange({ ...value, nodeId: event.target.value })}>
            {upstreamNodes.filter(node => node.type === 'tool').map(node => <option key={node.nodeId} value={node.nodeId}>{node.label}</option>)}
          </select>
          <input disabled={readOnly} value={value.kind} placeholder="例如 nowcast_sequence" onChange={event => onChange({ ...value, kind: event.target.value })} />
          <input disabled={readOnly} value={value.path} placeholder="refId" onChange={event => onChange({ ...value, path: event.target.value })} />
        </>
      ) : null}
    </div>
  )
}

function RetryFields({ readOnly, retry, onChange }: {
  readOnly: boolean
  retry: { maxAttempts: number; backoffSeconds: number }
  onChange: (retry: { maxAttempts: number; backoffSeconds: number }) => void
}) {
  return (
    <div className="automation-inspector__grid">
      <InspectorField label="最大尝试"><input disabled={readOnly} type="number" min={1} max={5} value={retry.maxAttempts} onChange={event => onChange({ ...retry, maxAttempts: Number(event.target.value) })} /></InspectorField>
      <InspectorField label="退避秒数"><input disabled={readOnly} type="number" min={0} max={300} value={retry.backoffSeconds} onChange={event => onChange({ ...retry, backoffSeconds: Number(event.target.value) })} /></InspectorField>
    </div>
  )
}

function InspectorField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="automation-inspector__field"><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>
}

function uniqueOutputName(outputs: Record<string, unknown>): string {
  let index = Object.keys(outputs).length + 1
  while (`output${index}` in outputs) index += 1
  return `output${index}`
}

function formatLiteral(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function parseLiteral(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try { return JSON.parse(trimmed) } catch { return value }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 节点卡片
//
//   文件:       AutomationNodeCard.tsx
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  Bot,
  CheckCircle2,
  GitBranch,
  Play,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { AutomationNodeType } from '@geo-agent-platform/shared-types'
import type { StudioFlowNode } from './automationStudioModel'

const ICONS: Record<AutomationNodeType, LucideIcon> = {
  trigger: Play,
  tool: Wrench,
  agent: Bot,
  condition: GitBranch,
  approval: ShieldCheck,
  output: CheckCircle2,
}

export function AutomationNodeCard({ data }: NodeProps<StudioFlowNode>) {
  const node = data.automationNode
  const Icon = ICONS[node.type]
  const ports = sourcePorts(node.type)
  return (
    <article className={`automation-node automation-node--${node.type}${data.selected ? ' is-selected' : ''}`}>
      {node.type !== 'trigger' ? <Handle type="target" position={Position.Left} id="target" className="automation-node__handle" /> : null}
      <div className="automation-node__header">
        <span className="automation-node__icon"><Icon size={16} aria-hidden="true" /></span>
        <div>
          <strong>{node.label}</strong>
          <span>{nodeTypeLabel(node.type)}</span>
        </div>
      </div>
      <p>{node.description || nodeSummary(node)}</p>
      {ports.map((port, index) => (
        <div className="automation-node__port" key={port} style={{ top: `${38 + index * 28}%` }}>
          <span>{portLabel(port)}</span>
          <Handle type="source" position={Position.Right} id={port} className="automation-node__handle" />
        </div>
      ))}
    </article>
  )
}

function sourcePorts(type: AutomationNodeType): string[] {
  if (type === 'output') return []
  if (type === 'condition') return ['true', 'false']
  if (type === 'approval') return ['approved', 'rejected']
  if (type === 'tool' || type === 'agent') return ['success', 'error']
  return ['default']
}

function nodeTypeLabel(type: AutomationNodeType): string {
  if (type === 'trigger') return '触发器'
  if (type === 'tool') return '工具节点'
  if (type === 'agent') return '智能体节点'
  if (type === 'condition') return '条件分支'
  if (type === 'approval') return '人工审批'
  return '输出节点'
}

function portLabel(port: string): string {
  if (port === 'success') return '成功'
  if (port === 'error') return '失败'
  if (port === 'true') return '满足'
  if (port === 'false') return '不满足'
  if (port === 'approved') return '批准'
  if (port === 'rejected') return '拒绝'
  return '继续'
}

function nodeSummary(node: StudioFlowNode['data']['automationNode']): string {
  if (node.type === 'tool') return '执行已配置工具并传递结构化结果'
  if (node.type === 'agent') return '根据上下文执行智能分析'
  if (node.type === 'condition') return node.config.operator
  if (node.type === 'approval') return node.config.question
  if (node.type === 'output') return `${Object.keys(node.config.outputs).length} 个输出字段`
  return '接收手动、定时或系统触发'
}

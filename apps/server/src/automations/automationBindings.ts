// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 数据绑定
//
//   文件:       automationBindings.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import Mustache from 'mustache'
import type { AutomationBinding } from './schemas.js'

export interface AutomationBindingContext {
  prompt: string
  parameters: Record<string, unknown>
  nodeOutputs: Record<string, Record<string, unknown>>
}

export function resolveAutomationBinding(binding: AutomationBinding, context: AutomationBindingContext): unknown {
  if (binding.source === 'literal') return structuredClone(binding.value)
  if (binding.source === 'input') {
    return resolvePath({ prompt: context.prompt, parameters: context.parameters }, binding.path, 'Automation 输入')
  }
  const output = context.nodeOutputs[binding.nodeId]
  if (!output) throw new Error(`节点 '${binding.nodeId}' 尚无可用输出。`)
  if (binding.source === 'value_ref') {
    const refs = Array.isArray(output.valueRefs) ? output.valueRefs : []
    const matches = refs.filter(ref => isRecord(ref) && ref.kind === binding.kind)
    if (matches.length === 0) {
      throw new Error(`节点 '${binding.nodeId}' 没有 kind 为 '${binding.kind}' 的 valueRef。`)
    }
    if (matches.length > 1) {
      throw new Error(`节点 '${binding.nodeId}' 存在 ${matches.length} 个 kind 为 '${binding.kind}' 的 valueRef，绑定结果不唯一。`)
    }
    return resolvePath(matches[0], binding.path, `节点 '${binding.nodeId}' 的 ${binding.kind} valueRef`)
  }
  return resolvePath(output, binding.path, `节点 '${binding.nodeId}' 输出`)
}

export function resolveAutomationArguments(
  bindings: Record<string, AutomationBinding>,
  context: AutomationBindingContext,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [
    name,
    resolveAutomationBinding(binding, context),
  ]))
}

export function renderAutomationPrompt(template: string, context: AutomationBindingContext): string {
  const nodes = Object.fromEntries(Object.entries(context.nodeOutputs).map(([nodeId, output]) => [
    nodeId,
    { ...output, json: JSON.stringify(output) },
  ]))
  const rendered = Mustache.render(template, {
    input: { prompt: context.prompt, parameters: context.parameters },
    nodes,
  }).trim()
  if (!rendered) throw new Error('Agent 节点渲染后的提示词为空。')
  return rendered
}

export function evaluateAutomationCondition(
  left: unknown,
  operator: 'equals' | 'not_equals' | 'greater_than' | 'greater_or_equal' | 'less_than' | 'less_or_equal' | 'contains' | 'exists' | 'is_true',
  right: unknown,
): boolean {
  if (operator === 'exists') return left !== null && left !== undefined
  if (operator === 'is_true') return left === true
  if (operator === 'equals') return Object.is(left, right)
  if (operator === 'not_equals') return !Object.is(left, right)
  if (operator === 'contains') {
    if (typeof left === 'string') return left.includes(String(right ?? ''))
    if (Array.isArray(left)) return left.some(value => Object.is(value, right))
    throw new Error('contains 条件左值必须是字符串或数组。')
  }
  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new Error(`条件 '${operator}' 的左右值都必须是数字。`)
  }
  if (operator === 'greater_than') return left > right
  if (operator === 'greater_or_equal') return left >= right
  if (operator === 'less_than') return left < right
  return left <= right
}

function resolvePath(root: unknown, path: string, label: string): unknown {
  const segments = path.split('.').filter(Boolean)
  let current = root
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`${label}路径 '${path}' 的数组索引 '${segment}' 无效。`)
      }
      current = current[index]
      continue
    }
    if (!isRecord(current) || !(segment in current)) {
      throw new Error(`${label}不存在路径 '${path}'。`)
    }
    current = current[segment]
  }
  return structuredClone(current)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

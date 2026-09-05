// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 注册表
//
//   文件:       automationRegistry.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 内置 Automation 注册表。
// 一个 JSON 文件对应一个完整图定义；加载失败只形成诊断，不阻断其它定义和服务启动。

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { automationDefinitionSchema, type AutomationDefinition } from './schemas.js'

export interface AutomationLoadDiagnostic {
  file: string
  severity: 'warning' | 'error'
  message: string
}

export class AutomationRegistry {
  private readonly definitions = new Map<string, AutomationDefinition>()
  private readonly diagnostics: AutomationLoadDiagnostic[] = []

  register(definition: AutomationDefinition): void {
    if (this.definitions.has(definition.automationId)) {
      throw new Error(`Automation '${definition.automationId}' 重复注册。`)
    }
    this.definitions.set(definition.automationId, structuredClone(definition))
  }

  addDiagnostic(diagnostic: AutomationLoadDiagnostic): void {
    this.diagnostics.push(diagnostic)
  }

  list(): AutomationDefinition[] {
    return [...this.definitions.values()]
      .map(definition => structuredClone(definition))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  }

  get(automationId: string): AutomationDefinition | null {
    const definition = this.definitions.get(automationId)
    return definition ? structuredClone(definition) : null
  }

  require(automationId: string): AutomationDefinition {
    const definition = this.get(automationId)
    if (!definition) throw new Error(`Automation '${automationId}' 不存在。`)
    if (!definition.enabled || definition.lifecycle === 'disabled') {
      throw new Error(`Automation '${definition.name}' 已禁用。`)
    }
    if (definition.lifecycle !== 'published') {
      throw new Error(`Automation '${definition.name}' 尚未发布。`)
    }
    return definition
  }

  loadDiagnostics(): AutomationLoadDiagnostic[] {
    return this.diagnostics.map(diagnostic => ({ ...diagnostic }))
  }
}

export async function createAutomationRegistryFromDirectory(directoryPath: string): Promise<AutomationRegistry> {
  const registry = new AutomationRegistry()
  let entries: string[]
  try {
    entries = await readdir(directoryPath)
  } catch (error) {
    registry.addDiagnostic({
      file: directoryPath,
      severity: 'warning',
      message: `Automation 目录不可读取：${formatLoadError(error)}`,
    })
    return registry
  }

  for (const entry of entries.filter(name => name.toLowerCase().endsWith('.json')).sort()) {
    const filePath = path.join(directoryPath, entry)
    try {
      const raw = await readFile(filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const definition = automationDefinitionSchema.parse({
        ...(isRecord(parsed) ? parsed : {}),
        source: 'builtin',
        lifecycle: isRecord(parsed) && parsed.lifecycle === 'disabled' ? 'disabled' : 'published',
        workspaceId: null,
        createdByUserId: null,
      })
      registry.register(definition)
    } catch (error) {
      registry.addDiagnostic({
        file: entry,
        severity: 'error',
        message: `Automation 定义加载失败：${formatLoadError(error)}`,
      })
    }
  }
  if (!registry.list().length) {
    registry.addDiagnostic({
      file: directoryPath,
      severity: 'warning',
      message: '未加载到任何可用 Automation。',
    })
  }
  return registry
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatLoadError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return '未知错误'
}

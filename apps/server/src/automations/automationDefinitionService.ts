// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 定义服务
//
//   文件:       automationDefinitionService.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 Automation 定义、修订和发布服务。
// 内置 JSON 与工作区草稿通过同一图编译器验证，发布后执行器固定消费修订快照。

import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'
import type { AutomationStore } from '../store/postgres/automationStore.js'
import { makeId, nowUtc } from '../utils/ids.js'
import {
  automationDefinitionSchema,
  type AutomationDefinition,
  type AutomationValidationResult,
  type AutomationVersionRecord,
} from './schemas.js'
import type { AutomationCompiler } from './automationCompiler.js'
import { collectRequiredTools } from './automationCompiler.js'
import type { AutomationLoadDiagnostic, AutomationRegistry } from './automationRegistry.js'

export interface AutomationListResult {
  definitions: AutomationDefinition[]
  diagnostics: AutomationLoadDiagnostic[]
  validation: Record<string, AutomationValidationResult>
}

export interface AutomationDraftInput {
  automationId?: string | undefined
  name: string
  description: string
  version: string
  parametersSchema: Record<string, unknown>
  defaultParameters: Record<string, unknown>
  timeoutSeconds: number
  outputType: string
  agentInvocation?: AutomationDefinition['agentInvocation'] | undefined
  graph: AutomationDefinition['graph']
}

export class AutomationDefinitionService {
  constructor(private readonly deps: {
    automations: Pick<AutomationStore,
      | 'createAutomationDefinition'
      | 'disableAutomationDefinition'
      | 'getAutomationDefinition'
      | 'getAutomationDefinitionVersion'
      | 'getPublishedAutomationDefinition'
      | 'listAutomationDefinitions'
      | 'listAutomationDefinitionVersions'
      | 'publishAutomationDefinition'
      | 'saveAutomationDefinitionRevision'
      | 'syncAutomationDefinitions'
    >
    registry: AutomationRegistry
    compiler: AutomationCompiler
    security: SecurityServices
  }) {}

  async initialize(): Promise<void> {
    const definitions = this.deps.registry.list().map(definition => {
      const validation = this.deps.compiler.validate(definition)
      if (!validation.valid) {
        const messages = validation.issues
          .filter(issue => issue.severity === 'error')
          .map(issue => issue.message)
          .join('；')
        this.deps.registry.addDiagnostic({
          file: `${definition.automationId}.json`,
          severity: 'error',
          message: `Automation 图编译失败：${messages}`,
        })
        return { ...definition, enabled: false, lifecycle: 'disabled' as const }
      }
      return { ...definition, requiredTools: validation.requiredTools }
    })
    await this.deps.automations.syncAutomationDefinitions(definitions)
  }

  async list(auth: AuthContext): Promise<AutomationListResult> {
    await this.deps.security.authorization.enforce(auth, 'automation', 'read', {
      workspaceId: auth.defaultWorkspaceId,
    })
    const definitions = await this.deps.automations.listAutomationDefinitions(auth.defaultWorkspaceId)
    return {
      definitions,
      diagnostics: this.deps.registry.loadDiagnostics(),
      validation: Object.fromEntries(definitions.map(definition => [
        definition.automationId,
        this.deps.compiler.validate(definition),
      ])),
    }
  }

  async validate(auth: AuthContext, input: AutomationDraftInput): Promise<AutomationValidationResult> {
    await this.deps.security.authorization.enforce(auth, 'automation', 'create', {
      workspaceId: auth.defaultWorkspaceId,
    })
    return this.deps.compiler.validate(this.toDraftDefinition(auth, input, 1))
  }

  async create(auth: AuthContext, input: AutomationDraftInput): Promise<AutomationDefinition> {
    await this.deps.security.authorization.enforce(auth, 'automation', 'create', {
      workspaceId: auth.defaultWorkspaceId,
    })
    const definition = this.toDraftDefinition(auth, { ...input, automationId: undefined }, 1)
    const validation = this.deps.compiler.validate(definition)
    assertValidation(validation)
    const saved = await this.deps.automations.createAutomationDefinition({
      ...definition,
      requiredTools: validation.requiredTools,
    })
    await this.deps.security.authorization.audit(auth, 'automation', 'create', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: saved.automationId,
    }, 'allowed', { revision: saved.revision })
    return saved
  }

  async saveDraft(
    auth: AuthContext,
    automationId: string,
    expectedRevision: number,
    input: AutomationDraftInput,
  ): Promise<AutomationDefinition> {
    const existing = await this.requireWorkspaceDefinition(auth, automationId, 'update')
    const definition = this.toDraftDefinition(auth, { ...input, automationId }, expectedRevision + 1, existing.createdAt, existing.publishedRevision)
    const validation = this.deps.compiler.validate(definition)
    assertValidation(validation)
    const saved = await this.deps.automations.saveAutomationDefinitionRevision({
      ...definition,
      requiredTools: validation.requiredTools,
    }, expectedRevision)
    await this.deps.security.authorization.audit(auth, 'automation', 'update', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: automationId,
    }, 'allowed', { fromRevision: expectedRevision, toRevision: saved.revision })
    return saved
  }

  async publish(auth: AuthContext, automationId: string, revision: number): Promise<AutomationDefinition> {
    await this.requireWorkspaceDefinition(auth, automationId, 'update')
    const version = await this.deps.automations.getAutomationDefinitionVersion(automationId, revision)
    if (!version) throw new Error(`Automation '${automationId}' 修订 ${revision} 不存在。`)
    const compiled = this.deps.compiler.compile(version)
    const published = await this.deps.automations.publishAutomationDefinition(automationId, revision)
    await this.deps.security.authorization.audit(auth, 'automation', 'update', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: automationId,
    }, 'allowed', { operation: 'publish', revision, requiredTools: compiled.definition.requiredTools })
    return published
  }

  async disable(auth: AuthContext, automationId: string): Promise<AutomationDefinition> {
    await this.requireWorkspaceDefinition(auth, automationId, 'delete')
    const disabled = await this.deps.automations.disableAutomationDefinition(automationId)
    await this.deps.security.authorization.audit(auth, 'automation', 'delete', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: automationId,
    }, 'allowed', { operation: 'disable' })
    return disabled
  }

  async history(auth: AuthContext, automationId: string): Promise<AutomationVersionRecord[]> {
    const definition = await this.requireVisibleDefinition(auth, automationId, 'read')
    return this.deps.automations.listAutomationDefinitionVersions(definition.automationId)
  }

  async requirePublished(workspaceId: string, automationId: string, revision?: number): Promise<AutomationDefinition> {
    const definition = revision
      ? await this.deps.automations.getAutomationDefinitionVersion(automationId, revision)
      : await this.deps.automations.getPublishedAutomationDefinition(automationId)
    if (!definition) throw new Error(`Automation '${automationId}' 不存在。`)
    if (definition.source === 'workspace' && definition.workspaceId !== workspaceId) {
      throw new Error('无权访问该 Automation。')
    }
    if (!definition.enabled || definition.lifecycle !== 'published') {
      throw new Error(`Automation '${definition.name}' 未发布或已禁用。`)
    }
    return definition
  }

  async authorizeExecution(auth: AuthContext, automationId: string): Promise<void> {
    await this.deps.security.authorization.enforce(auth, 'automation', 'execute', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: automationId,
    })
  }

  async authorizeRead(auth: AuthContext, automationId?: string): Promise<void> {
    await this.deps.security.authorization.enforce(auth, 'automation', 'read', {
      workspaceId: auth.defaultWorkspaceId,
      ...(automationId ? { resourceId: automationId } : {}),
    })
  }

  private async requireVisibleDefinition(
    auth: AuthContext,
    automationId: string,
    action: 'read' | 'update' | 'delete',
  ): Promise<AutomationDefinition> {
    const definition = await this.deps.automations.getAutomationDefinition(automationId)
    if (!definition) throw new Error(`Automation '${automationId}' 不存在。`)
    if (definition.source === 'workspace' && definition.workspaceId !== auth.defaultWorkspaceId) {
      throw new Error('无权访问该 Automation。')
    }
    await this.deps.security.authorization.enforce(auth, 'automation', action, {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: automationId,
    })
    return definition
  }

  private async requireWorkspaceDefinition(
    auth: AuthContext,
    automationId: string,
    action: 'update' | 'delete',
  ): Promise<AutomationDefinition> {
    const definition = await this.requireVisibleDefinition(auth, automationId, action)
    if (definition.source !== 'workspace') throw new Error('内置自动化流程只读，不能直接修改。请复制为工作区自动化流程。')
    return definition
  }

  private toDraftDefinition(
    auth: AuthContext,
    input: AutomationDraftInput,
    revision: number,
    createdAt: string | null = nowUtc(),
    publishedRevision: number | null = null,
  ): AutomationDefinition {
    return automationDefinitionSchema.parse({
      automationId: input.automationId?.trim() || makeId('automation'),
      name: input.name.trim(),
      description: input.description.trim(),
      version: input.version.trim(),
      revision,
      publishedRevision,
      source: 'workspace',
      lifecycle: 'draft',
      workspaceId: auth.defaultWorkspaceId,
      createdByUserId: auth.userId,
      enabled: true,
      parametersSchema: input.parametersSchema,
      defaultParameters: input.defaultParameters,
      requiredTools: collectRequiredTools(input.graph),
      requiresApproval: input.graph.nodes.some(node => node.type === 'approval'),
      timeoutSeconds: input.timeoutSeconds,
      outputType: input.outputType,
      agentInvocation: input.agentInvocation,
      graph: input.graph,
      createdAt,
      updatedAt: nowUtc(),
    })
  }
}

function assertValidation(validation: AutomationValidationResult): void {
  if (validation.valid) return
  const detail = validation.issues
    .filter(issue => issue.severity === 'error')
    .map(issue => issue.message)
    .join('；')
  throw new Error(`Automation 图校验失败：${detail}`)
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 持久化门面
//
//   文件:       automationStore.ts
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Database } from '../../db/connection.js'
import type {
  ScheduledTask,
  AutomationDefinition,
  AutomationRunRecord,
  AutomationVersionRecord,
} from '../../automations/schemas.js'
import {
  ScheduledTaskRepository,
  type CreateScheduledTaskInput,
  type UpdateScheduledTaskInput,
} from './scheduledTaskRepository.js'
import { AutomationDefinitionRepository } from './automationDefinitionRepository.js'
import {
  AutomationRunRepository,
  type CreateAutomationRunInput,
  type UpdateAutomationRunInput,
} from './automationRunRepository.js'

export type {
  CreateScheduledTaskInput,
  UpdateScheduledTaskInput,
} from './scheduledTaskRepository.js'
export type {
  CreateAutomationRunInput,
  UpdateAutomationRunInput,
} from './automationRunRepository.js'

/**
 * 保留面向平台服务的稳定组合接口；资源写入分别由定义、调度和运行仓储负责。
 * 门面不持有数据库连接，也不跨资源实现事务。
 */
export class AutomationStore {
  private readonly definitions: AutomationDefinitionRepository
  private readonly schedules: ScheduledTaskRepository
  private readonly runs: AutomationRunRepository

  constructor(db: Database) {
    this.definitions = new AutomationDefinitionRepository(db)
    this.schedules = new ScheduledTaskRepository(db)
    this.runs = new AutomationRunRepository(db)
  }

  syncAutomationDefinitions(definitions: AutomationDefinition[]): Promise<void> {
    return this.definitions.syncDefinitions(definitions)
  }

  listAutomationDefinitions(workspaceId: string): Promise<AutomationDefinition[]> {
    return this.definitions.listDefinitions(workspaceId)
  }

  getAutomationDefinition(automationId: string): Promise<AutomationDefinition | null> {
    return this.definitions.getDefinition(automationId)
  }

  getAutomationDefinitionVersion(automationId: string, revision: number): Promise<AutomationDefinition | null> {
    return this.definitions.getDefinitionVersion(automationId, revision)
  }

  getPublishedAutomationDefinition(automationId: string): Promise<AutomationDefinition | null> {
    return this.definitions.getPublishedDefinition(automationId)
  }

  listAutomationDefinitionVersions(automationId: string): Promise<AutomationVersionRecord[]> {
    return this.definitions.listDefinitionVersions(automationId)
  }

  createAutomationDefinition(definition: AutomationDefinition): Promise<AutomationDefinition> {
    return this.definitions.createDefinition(definition)
  }

  saveAutomationDefinitionRevision(
    definition: AutomationDefinition,
    expectedRevision: number,
  ): Promise<AutomationDefinition> {
    return this.definitions.saveDefinitionRevision(definition, expectedRevision)
  }

  publishAutomationDefinition(automationId: string, revision: number): Promise<AutomationDefinition> {
    return this.definitions.publishDefinition(automationId, revision)
  }

  disableAutomationDefinition(automationId: string): Promise<AutomationDefinition> {
    return this.definitions.disableDefinition(automationId)
  }

  listScheduledTasks(workspaceId: string): Promise<ScheduledTask[]> {
    return this.schedules.listScheduledTasks(workspaceId)
  }

  listActiveScheduledTasks(): Promise<ScheduledTask[]> {
    return this.schedules.listActiveScheduledTasks()
  }

  getScheduledTask(taskId: string): Promise<ScheduledTask | null> {
    return this.schedules.getScheduledTask(taskId)
  }

  createScheduledTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    return this.schedules.createScheduledTask(input)
  }

  updateScheduledTask(taskId: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask> {
    return this.schedules.updateScheduledTask(taskId, input)
  }

  deleteScheduledTask(taskId: string): Promise<ScheduledTask> {
    return this.schedules.markScheduledTaskDeleted(taskId)
  }

  createAutomationRunRecord(input: CreateAutomationRunInput): Promise<AutomationRunRecord> {
    return this.runs.createAutomationRun(input)
  }

  getAutomationRunRecord(automationRunId: string): Promise<AutomationRunRecord | null> {
    return this.runs.getAutomationRun(automationRunId)
  }

  updateAutomationRunRecord(
    automationRunId: string,
    input: UpdateAutomationRunInput,
  ): Promise<AutomationRunRecord> {
    return this.runs.updateAutomationRun(automationRunId, input)
  }

  listAutomationRuns(
    workspaceId: string,
    scheduledTaskId?: string | null,
  ): Promise<AutomationRunRecord[]> {
    return this.runs.listAutomationRuns(workspaceId, scheduledTaskId)
  }

  listQueuedAutomationRuns(): Promise<AutomationRunRecord[]> {
    return this.runs.listQueuedAutomationRuns()
  }
}

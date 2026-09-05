// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 执行状态
//
//   文件:       automationExecutionState.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'
import { automationApprovalRequestSchema, automationDefinitionSchema, automationNodeRunSchema, type AutomationDefinition } from './schemas.js'

const automationExecutionStateSchema = z.object({
  definitionSnapshot: automationDefinitionSchema,
  prompt: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  sessionId: z.string().nullable().default(null),
  threadId: z.string().nullable().default(null),
  orchestrationRunId: z.string().nullable().default(null),
  orchestrationRunOwnership: z.enum(['automation', 'external']).default('automation'),
  nodeOutputs: z.record(z.string(), z.record(z.string(), z.unknown())).prefault({}),
  selectedPorts: z.record(z.string(), z.array(z.string())).prefault({}),
  approvedNodeIds: z.array(z.string()).default([]),
  currentAgentRunId: z.string().nullable().default(null),
  nodeRuns: z.array(automationNodeRunSchema),
  pendingApproval: automationApprovalRequestSchema.nullable().default(null),
})

export type AutomationExecutionState = z.infer<typeof automationExecutionStateSchema>

export function createAutomationExecutionState(input: {
  definition: AutomationDefinition
  prompt: string
  parameters: Record<string, unknown>
  executionTarget?: {
    sessionId: string
    threadId: string
    runId: string
  } | undefined
}): AutomationExecutionState {
  return automationExecutionStateSchema.parse({
    definitionSnapshot: structuredClone(input.definition),
    prompt: input.prompt,
    parameters: structuredClone(input.parameters),
    sessionId: input.executionTarget?.sessionId ?? null,
    threadId: input.executionTarget?.threadId ?? null,
    orchestrationRunId: input.executionTarget?.runId ?? null,
    orchestrationRunOwnership: input.executionTarget ? 'external' : 'automation',
    nodeOutputs: {},
    selectedPorts: {},
    approvedNodeIds: [],
    currentAgentRunId: null,
    nodeRuns: input.definition.graph.nodes.map(node => ({
      nodeId: node.nodeId,
      nodeType: node.type,
      label: node.label,
      status: 'pending',
      attempt: 0,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      output: {},
    })),
    pendingApproval: null,
  })
}

export function parseAutomationExecutionState(metadata: Record<string, unknown>): AutomationExecutionState {
  return automationExecutionStateSchema.parse(metadata.executionState)
}

export function withExecutionState(
  metadata: Record<string, unknown>,
  executionState: AutomationExecutionState,
): Record<string, unknown> {
  return {
    ...metadata,
    executionState: structuredClone(executionState),
  }
}

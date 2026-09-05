// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 运行时类型
//
//   文件:       runtimeTypes.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Agent,Runner } from '@openai/agents'
import type { SandboxRunConfig } from '@openai/agents/sandbox'

import type { AgentRunProfile } from '@geo-agent-platform/shared-types/core'
import type { AgentRuntimeConfig } from '@geo-agent-platform/shared-types/runtime'
import type { ModelAdapter } from '../model/registry.js'
import type { ModelCapabilitySnapshot } from '../schemas/types.js'
import type { AuthContext } from '../security/types.js'
import type { CanonicalAgentsSession } from '../agent-runtime/sdk/CanonicalAgentsSession.js'
import type { AgentsExecutionContext } from './agentsToolBridge.js'
import type { ToolExecutionCoordinator } from './toolExecutionCoordinator.js'
import type { RuntimeSdkIntegration } from './runtimeSdkIntegrations.js'
import type { RuntimeModelInputController } from './runtimeModelInput.js'
import type { RecordedAgentStepContext } from '../agent-runtime/step/AgentStepContextFactory.js'
import type { AgentsSdkState } from '../agent-runtime/sdk/AgentsSdkBridge.js'
import type { RunModelUsageRecorder } from './runModelUsageRecorder.js'

export interface RunOptions {
  runId: string
  threadId?: string | null
  sessionId: string
  query: string
  provider: string
  modelName?: string | null
  runtimeConfig: AgentRuntimeConfig
  executionMode?: 'plan' | 'auto'
  runProfile?: AgentRunProfile
  reasoning?: boolean
  resume?: boolean
  auth?: AuthContext | null
  signal?: AbortSignal
}

export interface RuntimeAssembly {
  agent: Agent<AgentsExecutionContext>
  runner: Runner
  session: CanonicalAgentsSession
  context: AgentsExecutionContext
  coordinator: ToolExecutionCoordinator
  adapter: ModelAdapter
  modelName: string
  modelCapabilities: ModelCapabilitySnapshot
  sandbox?: SandboxRunConfig
  sdkIntegration: RuntimeSdkIntegration
  modelInput: RuntimeModelInputController
  modelUsageRecorder: RunModelUsageRecorder
  configDigest: string
  sdkVersion: string
  threadId: string
  turnId: string
  segmentId: string
  replayInputLeaseId: string | null
  checkpointContext: {
    current(): RecordedAgentStepContext | null
    adopt(context: RecordedAgentStepContext): void
    subscribe(listener: (context: RecordedAgentStepContext) => Promise<void>): () => void
  }
  subAgentToolNames: ReadonlySet<string>
  handoffToolNames: ReadonlySet<string>
  handoffAgentNames: ReadonlySet<string>
  mcpToolNames: ReadonlySet<string>
  hostedToolNames: ReadonlySet<string>
  sandboxToolNames: ReadonlySet<string>
  isUnavailableSdkToolCall: (callId: string) => boolean
  completeHandoff: (agentId: string, summary: string) => Promise<void>
  failHandoff: (agentId: string, message: string) => Promise<void>
}

export type RuntimeAgentsSdkState = AgentsSdkState<AgentsExecutionContext>

export interface StreamProjectionState {
  assistantItemId: string | null
  reasoningItemId: string | null
  lastAssistantText: string
  lastAssistantSdkItemId: string | null
  completedAssistantItems: Array<{
    itemId: string
    text: string
    sdkItemId: string | null
    entryId: string | null
  }>
  subAgentCallItemIds: Map<string, string>
}

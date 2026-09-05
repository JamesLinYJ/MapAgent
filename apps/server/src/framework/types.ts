// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具框架类型
//
//   文件:       types.ts
//
//   日期:       2026年06月26日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { z } from 'zod'
import type {
    AgentToolEffect,
    AgentToolExposure,
    AgentToolParallelism,
    AgentToolReplayPolicy,
} from '@geo-agent-platform/shared-types/tool-runtime'
import type { AgentRuntimeConfig, ArtifactDisplay, MeteorologicalDatasetRecord } from '../schemas/types.js'
import type { AuthContext } from '../security/types.js'

type ToolExecutionSurface = 'agent' | 'automation' | 'debug'
type AgentToolResultMode = 'continue' | 'return_direct'
type AgentToolSchemaOverride = 'strict' | 'compatible'

export interface ToolRuntimePolicy {
    namespace?: string;
    exposure?: AgentToolExposure;
    effect?: AgentToolEffect;
    parallelism?: AgentToolParallelism;
    approvalAction?: string | null;
    replayPolicy?: AgentToolReplayPolicy;
    requiredCapabilities?: string[];
}

export interface ToolManifest {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    language: string;
    homepage?: string;
    endpoint?: string;
    requires?: Record<string, string>;
    tools: ToolManifestEntry[];
}
export interface ToolManifestEntry {
    name: string;
    label: string;
    description: string;
    group: string;
    tags: string[];
    isReadOnly: boolean;
    isDestructive: boolean;
    parallelSafe?: boolean;
    requiresApproval?: boolean;
    executionSurfaces?: ToolExecutionSurface[];
    agentResultMode?: AgentToolResultMode;
    agentSchemaMode?: AgentToolSchemaOverride;
    runtimePolicy?: ToolRuntimePolicy;
    jsonSchema: Record<string, unknown>;
}
export interface ToolDef {
    name: string;
    label: string;
    description: string;
    prompt: string;
    group: string;
    tags: string[];
    isReadOnly: boolean;
    isDestructive: boolean;
    parallelSafe?: boolean;
    requiresApproval?: boolean;
    executionSurfaces?: ToolExecutionSurface[];
    agentResultMode?: AgentToolResultMode;
    agentSchemaMode?: AgentToolSchemaOverride;
    runtimePolicy?: ToolRuntimePolicy;
    parameters?: z.ZodObject;
    jsonSchema?: Record<string, unknown>;
    handler: ToolHandler;
    providerId?: string;
    language?: string;
}
export type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
export interface ToolContext {
    runId: string;
    sessionId: string;
    threadId: string | null;
    /** 当前工具调用所属 Turn；仅 Agent 执行面保证提供。 */
    turnId?: string;
    /** 整棵持久子运行树共享的根 Turn。 */
    rootTurnId?: string;
    /** SDK/工具账本中的稳定调用 ID，可直接用作幂等键。 */
    toolCallId?: string;
    signal: AbortSignal;
    runtimeRoot?: string;
    runtimeConfig?: AgentRuntimeConfig;
    auth?: AuthContext | null;
    state: Map<string, unknown>;
    resolveValueRef(refId: string): ValueRef;
    resolveMeteorologicalDataset?(input:
        | { selector: 'explicit_dataset_id'; datasetId: string }
        | { selector: 'current_thread_latest'; filename?: string | null }
    ): Promise<MeteorologicalDatasetRecord | null>;
    resolveMeteorologicalDatasets?(datasetIds: string[]): Promise<MeteorologicalDatasetRecord[]>;
    listMeteorologicalDatasets?(input?: {
        scope?: 'session' | 'thread';
        filename?: string | null;
        limit?: number;
    }): Promise<MeteorologicalDatasetRecord[]>;
    invokeStructuredModel<TSchema extends z.ZodObject>(
        prompt: string,
        schema: TSchema,
        options?: { schemaVersion?: string },
    ): Promise<z.infer<TSchema>>;
    log(level: 'info' | 'warn' | 'error', message: string): void;
}
export interface ToolResult {
    message: string;
    payload: Record<string, unknown>;
    warnings: string[];
    resultId: string;
    source: string;
    modelOutput?: string;
    valueRefs?: ValueRef[];
    artifacts?: ToolArtifact[];
    provenance?: Record<string, unknown>;
}
export interface ValueRef {
    refId: string;
    kind: string;
    label: string;
    value: unknown;
    unit?: string | null;
    metadata?: Record<string, unknown>;
}
export interface ToolArtifact {
    artifactId: string;
    artifactType: string;
    name: string;
    uri: string;
    display: ArtifactDisplay;
    relativePath?: string | null;
    metadata?: Record<string, unknown>;
}
export interface ToolProvider {
    manifest: ToolManifest;
    tools(): ToolDef[];
    onInstall?(ctx: InstallContext): Promise<void>;
    onUninstall?(ctx: InstallContext): Promise<void>;
}
export interface InstallContext {
    config: Record<string, string | undefined>;
    state: Map<string, unknown>;
    log(level: 'info' | 'warn' | 'error', message: string): void;
}

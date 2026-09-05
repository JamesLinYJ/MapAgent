// +-------------------------------------------------------------------------
//
//   地理智能平台 - OpenAI Agents SDK opaque checkpoint 编解码器
//
//   文件:       AgentsSdkCheckpointCodec.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import { z } from 'zod'

export const AGENTS_SDK_CHECKPOINT_ENVELOPE_VERSION = 3 as const

const agentsSdkCheckpointEnvelopeSchema = z.object({
  envelopeVersion: z.literal(AGENTS_SDK_CHECKPOINT_ENVELOPE_VERSION),
  publicSerializedState: z.string().min(1),
  sdkVersion: z.string().min(1),
  sdkStateSchemaVersion: z.number().int().positive(),
  agentStepContextSchemaVersion: z.number().int().positive(),
  modelRequestSchemaVersion: z.number().int().positive(),
  runtimeConfigDigest: z.string().min(1),
  toolPlanDigest: z.string().min(1),
  worldRevision: z.number().int().positive(),
  objectiveRevision: z.number().int().positive(),
  inputCursor: z.number().int().nonnegative(),
  contextWindowId: z.string().min(1),
  contextDigest: z.string().min(1),
  modelRequestId: z.string().min(1),
  segmentId: z.string().min(1),
  stepId: z.string().min(1),
}).strict()

export type AgentsSdkCheckpointEnvelope = z.infer<typeof agentsSdkCheckpointEnvelopeSchema>

export class AgentsSdkCheckpointCodec {
  encode(envelope: AgentsSdkCheckpointEnvelope): string {
    return JSON.stringify(agentsSdkCheckpointEnvelopeSchema.parse(envelope))
  }

  decode(serializedEnvelope: string): AgentsSdkCheckpointEnvelope {
    let parsed: unknown
    try {
      parsed = JSON.parse(serializedEnvelope)
    } catch (error) {
      throw new Error('Agents SDK checkpoint envelope 不是合法 JSON', { cause: error })
    }
    return agentsSdkCheckpointEnvelopeSchema.parse(parsed)
  }
}

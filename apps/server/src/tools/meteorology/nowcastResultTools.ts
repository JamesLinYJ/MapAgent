// +-------------------------------------------------------------------------
//
//   地理智能平台 - 短临运行结果交付工具
//
//   文件:       nowcastResultTools.ts
//
//   日期:       2026年07月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { artifactRefSchema } from '@geo-agent-platform/shared-types/core'
import { automationRunRecordSchema } from '@geo-agent-platform/shared-types/resources'
import { z } from 'zod'

import type { ToolContext, ToolDef, ToolResult } from '../../framework/types.js'
import {
  artifactTarget,
  isRecord,
  mergeArtifactMetadata,
  requiredRefKind,
  result,
} from './toolRuntime.js'
import {
  refParameter,
  tool,
  type MeteorologyToolDeps,
  withMeteorologyDeps,
} from './toolDefinition.js'

const nowcastStatisticsSchema = z.object({
  min: z.number(),
  max: z.number(),
  mean: z.number(),
  median: z.number(),
  p90: z.number(),
  count: z.number().int().nonnegative(),
  rainCoverage: z.number().min(0).max(1),
})

const nowcastTimelineEntrySchema = z.object({
  stats: nowcastStatisticsSchema,
  filename: z.string().min(1),
  datasetId: z.string().min(1),
  rainLevel: z.string().min(1),
  validTime: z.string().min(1),
  leadMinutes: z.number().int().nonnegative(),
  sequenceIndex: z.number().int().nonnegative(),
})

const nowcastAnalysisSchema = z.object({
  kind: z.literal('nowcast_precipitation_analysis'),
  scope: z.record(z.string(), z.unknown()),
  regions: z.array(z.object({
    label: z.string().min(1),
    regionId: z.string().min(1),
    timeline: z.array(nowcastTimelineEntrySchema).min(1),
    diagnosis: z.object({
      trend: z.string().min(1),
      hasRain: z.boolean(),
      peakP90: z.number(),
      summary: z.string().min(1),
      peakLevel: z.string().min(1),
      endLeadMinutes: z.number().int().nonnegative().nullable(),
      peakLeadMinutes: z.number().int().nonnegative(),
      onsetLeadMinutes: z.number().int().nonnegative().nullable(),
    }),
  })).min(1),
  movement: z.object({
    available: z.boolean(),
    direction: z.string(),
    distanceKm: z.number().nonnegative(),
    from: z.object({ lat: z.number(), lng: z.number(), sequenceIndex: z.number().int().nonnegative() }),
    to: z.object({ lat: z.number(), lng: z.number(), sequenceIndex: z.number().int().nonnegative() }),
  }),
  variable: z.string().min(1),
  warnings: z.array(z.string()),
  sequenceId: z.string().min(1),
  mapCandidates: z.array(z.object({
    label: z.string(),
    reason: z.string(),
    filename: z.string(),
    variable: z.string(),
    datasetId: z.string(),
    validTime: z.string(),
    leadMinutes: z.number().int().nonnegative(),
    relativePath: z.string(),
    sequenceIndex: z.number().int().nonnegative(),
  })),
})

const automationNowcastResultSchema = automationRunRecordSchema.extend({
  status: z.literal('completed'),
  completedAt: z.string().min(1),
  outputs: z.record(z.string(), z.unknown()),
  artifacts: z.array(artifactRefSchema),
})

export function createNowcastResultTools(deps: MeteorologyToolDeps): ToolDef[] {
  return [
    tool(
      'meteorological_nowcast_report',
      '生成短临自动化报告',
      '从一条已完成的自动化运行事实生成确定性 DOCX 报告。',
      {
        automation_run_ref: refParameter('自动化运行结果引用', ['automation_run_output']),
      },
      withMeteorologyDeps(deps, generateNowcastReport),
      ['automation_run_ref'],
      { isReadOnly: false },
    ),
  ]
}

async function generateNowcastReport(
  args: Record<string, unknown>,
  context: ToolContext,
  deps: MeteorologyToolDeps,
): Promise<ToolResult> {
  const reference = requiredRefKind(context, args, 'automation_run_ref', ['automation_run_output'])
  const run = automationNowcastResultSchema.parse(reference.value)
  const answer = typeof run.outputs.answer === 'string' ? run.outputs.answer.trim() : ''
  if (!answer) throw new Error('自动化运行输出缺少可交付的 answer。')
  const analysis = nowcastAnalysisSchema.parse(run.outputs.analysis)
  const artifact = artifactTarget(context, 'docx', `${analysis.variable} 三小时气象短临监测报告`)
  const worker = await deps.callWorker('meteorological_nowcast_report', {
    automation_run_id: run.automationRunId,
    automation_id: run.automationId,
    automation_revision: run.automationRevision,
    started_at: run.startedAt,
    completed_at: run.completedAt,
    answer,
    analysis,
    artifacts: run.artifacts.map(item => ({
      artifactId: item.artifactId,
      artifactType: item.artifactType,
      name: item.name,
      uri: item.uri,
    })),
    output_relative_path: artifact.relativePath,
  }, context.signal)
  if (!isRecord(worker.payload)) throw new Error('短临报告 Worker 返回无效结果。')
  mergeArtifactMetadata(artifact, {
    ...worker.payload,
    sourceAutomationRunId: run.automationRunId,
  })
  return result(
    'meteorological_nowcast_report',
    worker.message,
    { ...worker.payload, automationRunId: run.automationRunId },
    [],
    [artifact],
  )
}

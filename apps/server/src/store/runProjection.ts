// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行列表投影
//
//   文件:       runProjection.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import type { AnalysisRun, RunSummary } from '../schemas/types.js'

const runCursorSchema = z.object({
  updatedAt: z.string().datetime({ offset: true }),
  id: z.string().min(1),
}).strict()

export type RunCursor = z.infer<typeof runCursorSchema>

export function compareRuns(left: AnalysisRun, right: AnalysisRun): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)
}

export function isRunAfterCursor(run: AnalysisRun, cursor: RunCursor): boolean {
  return run.updatedAt < cursor.updatedAt || (run.updatedAt === cursor.updatedAt && run.id < cursor.id)
}

export function encodeRunCursor(run: Pick<AnalysisRun, 'updatedAt' | 'id'>): string {
  const cursor = runCursorSchema.parse({ updatedAt: run.updatedAt, id: run.id })
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeRunCursor(cursor: string): RunCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    return runCursorSchema.parse(parsed)
  } catch {
    throw new Error('运行分页游标无效。')
  }
}

export function toRunSummary(run: AnalysisRun): RunSummary {
  const latestArtifact = run.state.artifacts.at(-1) ?? null
  return {
    id: run.id,
    threadId: run.threadId,
    sessionId: run.sessionId,
    workspaceId: run.workspaceId,
    createdByUserId: run.createdByUserId,
    visibility: run.visibility,
    userQuery: run.userQuery,
    modelProvider: run.modelProvider,
    modelName: run.modelName,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    artifactCount: run.state.artifacts.length,
    latestArtifactId: latestArtifact?.artifactId ?? null,
    latestArtifactName: latestArtifact?.name ?? null,
  }
}

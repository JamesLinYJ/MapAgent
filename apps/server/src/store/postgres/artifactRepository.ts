// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 持久化契约
//
//   文件:       artifactRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ArtifactDisplay, ArtifactRef } from '../../schemas/types.js'

export interface ArtifactOwnerProjection {
  workspaceId: string | null
  createdByUserId: string | null
  visibility: string
  threadId: string | null
  runCreatedAt: string
}

export interface ArtifactRecord {
  artifactId: string
  runId: string
  threadId: string | null
  runCreatedAt: string
  workspaceId: string | null
  createdByUserId: string | null
  visibility: string
  artifactType: string
  name: string
  uri: string
  display: ArtifactDisplay
  metadata: Record<string, unknown>
  relativePath: string
  createdAt: string
}

export interface VisibleArtifactQuery {
  threadId: string
  workspaceId: string | null
  visibleAt: string
  artifactIds?: readonly string[]
  limit?: number
}

export type ArtifactAvailability = 'available' | 'missing' | 'inaccessible' | 'invalid'

export interface VisibleArtifactResource extends ArtifactRecord {
  availability: ArtifactAvailability
  unavailableReason: string | null
  sandboxPath: string
  sourcePath: string | null
}

export interface ArtifactReader {
  getArtifact(artifactId: string): Promise<ArtifactRecord | null>
}

export interface VisibleArtifactReader {
  listVisibleArtifacts(query: VisibleArtifactQuery): Promise<ArtifactRecord[]>
}

export interface ArtifactRepository extends ArtifactReader, VisibleArtifactReader {
  persistArtifact(artifact: ArtifactRef, owner: ArtifactOwnerProjection): Promise<void>
  deleteRunArtifacts(runId: string): Promise<void>
}

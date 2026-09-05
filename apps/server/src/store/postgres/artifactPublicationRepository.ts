// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 发布仓储
//
//   文件:       artifactPublicationRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { eq } from 'drizzle-orm'

import type { Database, DatabaseTransaction } from '../../db/connection.js'
import { platformThreads } from '../../db/schema.js'
import type { ArtifactRef } from '../../schemas/types.js'
import { ArtifactMapProjectionRepository } from './artifactMapProjectionRepository.js'
import { ArtifactMetadataRepository } from './artifactMetadataRepository.js'
import type {
  ArtifactOwnerProjection,
  ArtifactRecord,
  ArtifactRepository,
  VisibleArtifactQuery,
} from './artifactRepository.js'

/**
 * Artifact 发布用例的原子事务边界：元数据、地图投影和线程导航指针必须同时成功。
 */
export class ArtifactPublicationRepository implements ArtifactRepository {
  private readonly metadata: ArtifactMetadataRepository
  private readonly mapProjection: ArtifactMapProjectionRepository

  constructor(private readonly db: Database) {
    this.metadata = new ArtifactMetadataRepository(db)
    this.mapProjection = new ArtifactMapProjectionRepository()
  }

  async persistArtifact(artifact: ArtifactRef, owner: ArtifactOwnerProjection): Promise<void> {
    await this.db.transaction(tx => this.persistInTransaction(tx, artifact, owner))
  }

  async persistInTransaction(
    tx: DatabaseTransaction,
    artifact: ArtifactRef,
    owner: ArtifactOwnerProjection,
  ): Promise<void> {
    const relativePath = typeof artifact.metadata.relativePath === 'string'
      ? artifact.metadata.relativePath
      : ''
    if (!relativePath) throw new Error(`Artifact "${artifact.artifactId}" 缺少 relativePath`)

    await this.metadata.upsert(tx, artifact, owner, relativePath)
    await this.mapProjection.publish(tx, artifact, owner)
    if (!artifact.isIntermediate && owner.threadId) {
      const updated = await tx.update(platformThreads).set({
        latestArtifactId: artifact.artifactId,
        latestArtifactName: artifact.name,
        updatedAt: new Date(),
      }).where(eq(platformThreads.threadId, owner.threadId))
        .returning({ threadId: platformThreads.threadId })
      if (!updated[0]) throw new Error(`Artifact 所属线程 '${owner.threadId}' 不存在`)
    }
  }

  deleteRunArtifacts(runId: string): Promise<void> {
    return this.metadata.deleteRunArtifacts(runId)
  }

  getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    return this.metadata.getArtifact(artifactId)
  }

  listVisibleArtifacts(query: VisibleArtifactQuery): Promise<ArtifactRecord[]> {
    return this.metadata.listVisibleArtifacts(query)
  }
}

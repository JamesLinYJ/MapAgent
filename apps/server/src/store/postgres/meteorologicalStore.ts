// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象持久化门面
//
//   文件:       meteorologicalStore.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Database } from '../../db/connection.js'
import type { MeteorologicalDatasetRecord, MeteorologicalJobRecord, SessionRecord } from '../../schemas/types.js'
import {
  MeteorologicalDatasetRepository,
  type ListMeteorologicalDatasetsFilters,
  type ResolveMeteorologicalDatasetFilters,
} from './meteorologicalDatasetRepository.js'
import { MeteorologicalJobRepository } from './meteorologicalJobRepository.js'

export type {
  ListMeteorologicalDatasetsFilters,
  ResolveMeteorologicalDatasetFilters,
} from './meteorologicalDatasetRepository.js'

/** 面向平台服务的稳定组合接口；Dataset 与 Job 分别由独立仓储持久化。 */
export class MeteorologicalStore {
  private readonly datasets: MeteorologicalDatasetRepository
  private readonly jobs: MeteorologicalJobRepository

  constructor(db: Database) {
    this.datasets = new MeteorologicalDatasetRepository(db)
    this.jobs = new MeteorologicalJobRepository(db)
  }

  listMeteorologicalDatasets(filters: ListMeteorologicalDatasetsFilters = {}): Promise<MeteorologicalDatasetRecord[]> {
    return this.datasets.list(filters)
  }

  countMeteorologicalDatasets(filters: ListMeteorologicalDatasetsFilters = {}): Promise<number> {
    return this.datasets.count(filters)
  }

  resolveMeteorologicalDataset(filters: ResolveMeteorologicalDatasetFilters): Promise<MeteorologicalDatasetRecord | null> {
    return this.datasets.resolve(filters)
  }

  getMeteorologicalDataset(datasetId: string): Promise<MeteorologicalDatasetRecord | null> {
    return this.datasets.get(datasetId)
  }

  createMeteorologicalDataset(dataset: MeteorologicalDatasetRecord): Promise<SessionRecord> {
    return this.datasets.create(dataset)
  }

  getMeteorologicalJob(jobId: string): Promise<MeteorologicalJobRecord | null> {
    return this.jobs.get(jobId)
  }

  createMeteorologicalJob(job: MeteorologicalJobRecord): Promise<void> {
    return this.jobs.create(job)
  }
}

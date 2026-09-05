// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象数据集事务边界测试
//
//   文件:       meteorologicalDatasetRepository.test.ts
//   日期:       2026年08月04日
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { Database } from '../../db/connection.js'
import type { MeteorologicalDatasetRecord } from '../../schemas/types.js'
import { MeteorologicalDatasetRepository } from './meteorologicalDatasetRepository.js'

describe('MeteorologicalDatasetRepository lifecycle', () => {
  it('rolls back the dataset insert when the latest-session pointer update fails', async () => {
    const insertedDatasets: unknown[] = []
    const transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => {
      const checkpoint = insertedDatasets.length
      try {
        return await operation(transactionClient(insertedDatasets, false))
      } catch (error) {
        insertedDatasets.splice(checkpoint)
        throw error
      }
    })
    const repository = new MeteorologicalDatasetRepository({ transaction } as unknown as Database)

    await expect(repository.create(dataset())).rejects.toThrow('气象数据指针更新失败')

    expect(transaction).toHaveBeenCalledOnce()
    expect(insertedDatasets).toEqual([])
  })
})

function transactionClient(insertedDatasets: unknown[], updateSucceeds: boolean) {
  const session = sessionRow()
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({ limit: async () => [session] }),
        }),
      }),
    }),
    insert: () => ({
      values: (value: unknown) => ({
        returning: async () => {
          insertedDatasets.push(value)
          return [{ datasetId: 'dataset_1' }]
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: async () => updateSucceeds ? [session] : [] }),
      }),
    }),
  }
}

function dataset(): MeteorologicalDatasetRecord {
  return {
    datasetId: 'dataset_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace',
    sessionId: 'session_1',
    threadId: 'thread_1',
    filename: 'weather.nc',
    originalFilename: 'weather.nc',
    fileId: 'file_1',
    fileRelativePath: `objects/sha256/${'a'.repeat(2)}/${'a'.repeat(64)}.nc`,
    sizeBytes: 7,
    contentHash: 'a'.repeat(64),
    mediaType: 'application/x-netcdf',
    status: 'ready',
    metadata: { source: 'upload' },
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
  }
}

function sessionRow() {
  return {
    sessionId: 'session_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace',
    status: 'active',
    latestThreadId: 'thread_1',
    latestRunId: null,
    latestUploadedLayerKey: null,
    latestMeteorologicalDatasetId: null,
    createdAt: new Date('2026-08-04T00:00:00.000Z'),
    updatedAt: new Date('2026-08-04T00:00:00.000Z'),
  }
}

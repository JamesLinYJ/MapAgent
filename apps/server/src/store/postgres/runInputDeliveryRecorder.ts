// +-------------------------------------------------------------------------
//
//   地理智能平台 - Run input delivery audit/outbox
//
//   输入状态转换的领域仓库调用此组件，把审计记录和实时通知写进同一事务。
// --------------------------------------------------------------------------

import { platformEventOutbox } from '../../db/schema.js'
import { currentLogContext } from '../../observability/logger.js'
import type { RunSteeringRecord } from '../../schemas/types.js'
import { makeId } from '../../utils/ids.js'
import { runInputConversationItem } from '../runInputConversationItem.js'
import type { RunRecordAppender, DatabaseTransaction } from './runRecordAppender.js'

type InputTransition = 'queued' | 'leased' | 'included' | 'requeued' | 'checkpointed'

export class RunInputDeliveryRecorder {
  constructor(private readonly runRecords: RunRecordAppender) {}

  async recordTransition(
    tx: DatabaseTransaction,
    transition: InputTransition,
    runId: string,
    threadId: string | null,
    records: readonly RunSteeringRecord[],
  ): Promise<void> {
    if (!records.length) return
    const traceId = stringContextValue('traceId')
    const transitions = records.map(record => ({
      inputId: record.steeringId,
      entryId: record.entryId,
      itemId: record.itemId,
      inputSequence: record.inputSequence,
      leaseId: record.leaseId,
      modelRequestId: record.modelRequestId,
    }))
    const items = records.map(runInputConversationItem)
    await this.runRecords.append(
      tx,
      runId,
      threadId,
      records.flatMap((_record, index) => [{
        recordType: `input.${transition}`,
        payloadJson: transitions[index]!,
      }, {
        recordType: 'item',
        payloadJson: items[index]!,
      }]),
      traceId,
    )
    await tx.insert(platformEventOutbox).values(records.flatMap((_record, index) => [{
      outboxId: makeId('outbox'),
      aggregateType: 'run',
      aggregateId: runId,
      eventType: `run.input.${transition}`,
      payloadJson: transitions[index]!,
      traceId,
    }, {
      outboxId: makeId('outbox'),
      aggregateType: 'run',
      aggregateId: runId,
      eventType: 'run.item',
      payloadJson: items[index]!,
      traceId,
    }]))
  }

  async recordCheckpointed(
    tx: DatabaseTransaction,
    runId: string,
    threadId: string | null,
    records: readonly RunSteeringRecord[],
  ): Promise<void> {
    await this.recordTransition(tx, 'checkpointed', runId, threadId, records)
  }
}

function stringContextValue(key: string): string | null {
  const value = currentLogContext()[key]
  return typeof value === 'string' && value.length ? value : null
}

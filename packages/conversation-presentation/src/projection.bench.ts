// +-------------------------------------------------------------------------
//
//   地理智能平台 - 增量对话投影基准
//
//   文件:       projection.bench.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import type { ConversationItem } from '@geo-agent-platform/shared-types'
import { bench, describe } from 'vitest'

import { ConversationProjectionIndex } from './projection.js'

describe('ConversationProjectionIndex streaming benchmark', () => {
  for (const count of [100, 1_000, 5_000]) {
    bench(`${count} item incremental upsert`, () => {
      const projection = new ConversationProjectionIndex()
      for (let index = 0; index < count; index += 1) {
        projection.upsert(makeItem(index), 'live')
      }
      projection.toArray()
    }, { iterations: 3, warmupIterations: 1 })
  }
})

function makeItem(index: number): ConversationItem {
  return {
    itemId: `bench-${index}`,
    itemType: 'message',
    runId: 'run-bench',
    threadId: 'thread-bench',
    turnId: 'turn-bench',
    callId: null,
    role: 'assistant',
    body: `消息 ${index}`,
    name: null,
    arguments: null,
    output: null,
    isError: false,
    phase: null,
    status: 'completed',
    metadata: { transcriptSeq: index },
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
  }
}

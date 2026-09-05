// +-------------------------------------------------------------------------
//
//   地理智能平台 - 平台领域事件中心
//
//   文件:       platformEventHub.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  AgentThreadRecord,
  AnalysisRun,
  CompactionRecord,
  ConversationItem,
  ConversationItemTextDelta,
  MapScene,
  RunEvent,
  RunItemUpsert,
  ThreadManifest,
  ThreadMemoryDocument,
  TranscriptEntry,
} from '../schemas/types.js'
import { InMemoryEventBus } from './eventBus.js'

/** 事件订阅生命周期独立于数据库仓储；数据库门面不再顺带暴露事件总线。 */
export class PlatformEventHub {
  readonly runEvents = new InMemoryEventBus<RunEvent>()
  readonly conversationItems = new InMemoryEventBus<ConversationItem>()
  readonly conversationItemUpserts = new InMemoryEventBus<RunItemUpsert>()
  readonly conversationItemDeltas = new InMemoryEventBus<ConversationItemTextDelta>()
  readonly runs = new InMemoryEventBus<AnalysisRun>()
  readonly threadEntries = new InMemoryEventBus<TranscriptEntry>()
  readonly threadUpdates = new InMemoryEventBus<{
    thread: AgentThreadRecord
    manifest: ThreadManifest
  }>()
  readonly threadCompactions = new InMemoryEventBus<CompactionRecord>()
  readonly threadMemories = new InMemoryEventBus<ThreadMemoryDocument>()
  readonly mapScenes = new InMemoryEventBus<MapScene>()
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话时间线增量投影 Hook
//
//   文件:       useConversationTimelineProjection.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { ConversationItem } from '@geo-agent-platform/shared-types'
import { ConversationTimelineProjectionStore } from '@geo-agent-platform/conversation-presentation'

/**
 * 合并 canonical transcript 与当前 run overlay。
 *
 * 索引在 layout effect 中吸收新事实；React render 只读取稳定快照。
 * 这保留按 item 增量更新，又不会让被放弃的并发渲染改写索引。
 */
export function useConversationTimelineProjection(
  canonical: ReadonlyArray<ConversationItem>,
  liveOverlay: ReadonlyArray<ConversationItem>,
): ConversationItem[] {
  const [projection] = useState(() => new ConversationTimelineProjectionStore(canonical, liveOverlay))
  useLayoutEffect(() => {
    projection.replaceSources(canonical, liveOverlay)
  }, [canonical, liveOverlay, projection])
  return useSyncExternalStore(
    projection.subscribe,
    projection.getSnapshot,
    projection.getSnapshot,
  )
}

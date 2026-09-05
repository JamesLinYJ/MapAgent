// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话时间线虚拟化规则
//
//   文件:       conversationTimelineVirtualization.ts
// --------------------------------------------------------------------------

export const CONVERSATION_TIMELINE_GAP_PX = 16

export function firstVisibleConversationIndex(
  virtualItems: ReadonlyArray<{ index: number; end: number }>,
  visibleOffset: number,
): number | undefined {
  return virtualItems.find(item => item.end > visibleOffset)?.index
}

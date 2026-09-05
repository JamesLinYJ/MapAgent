// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话末端滚动控制器
//
//   文件:       useConversationScrollController.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react'

import type { ConversationEntry } from '@geo-agent-platform/conversation-presentation'

interface ConversationVirtualizer {
  scrollToIndex(
    index: number,
    options: { align: 'center' | 'end'; behavior: 'auto' | 'smooth' },
  ): void
}

interface ConversationScrollElement {
  scrollTop: number
  readonly scrollHeight: number
}

interface ConversationScrollControllerOptions {
  conversation: ReadonlyArray<ConversationEntry>
  interactionRevision: string
  scrollElementRef: RefObject<HTMLDivElement | null>
  contentElementRef: RefObject<HTMLDivElement | null>
  virtualizer: ConversationVirtualizer
}

interface ConversationScrollControllerResult {
  jumpToIndex(index: number, behavior: 'auto' | 'smooth'): void
}

/**
 * 滚动规则的唯一状态机。用户主动使用跳转轨道后，虚拟列表的
 * 重新测量不能抢回位置；新消息、审批、错误或提交态变化则立即恢复跟随底部。
 */
export class ConversationScrollController {
  private explicitNavigation = false

  anchorToEnd(
    element: ConversationScrollElement,
    virtualizer: ConversationVirtualizer,
    itemCount: number,
  ): void {
    this.explicitNavigation = false
    anchorConversationToEnd(element, virtualizer, itemCount)
  }

  jumpToIndex(
    virtualizer: ConversationVirtualizer,
    index: number,
    behavior: 'auto' | 'smooth',
  ): void {
    this.explicitNavigation = true
    virtualizer.scrollToIndex(index, { align: 'center', behavior })
  }

  realignAfterContentResize(
    element: ConversationScrollElement,
    virtualizer: ConversationVirtualizer,
    itemCount: number,
  ): boolean {
    if (this.explicitNavigation) return false
    anchorConversationToEnd(element, virtualizer, itemCount)
    return true
  }
}

/**
 * 对话跟随的唯一所有者。任何服务端互动或内容测量变化都从当前位置
 * 立即落到末端；这里永远不使用 smooth。平滑滚动只属于用户主动点击
 * 跳转轨道的定位操作。
 */
export function useConversationScrollController({
  conversation,
  interactionRevision,
  scrollElementRef,
  contentElementRef,
  virtualizer,
}: ConversationScrollControllerOptions): ConversationScrollControllerResult {
  const controllerRef = useRef<ConversationScrollController | null>(null)
  if (!controllerRef.current) controllerRef.current = new ConversationScrollController()
  const resizeFrameRef = useRef<number | null>(null)
  const scrollToEnd = useCallback(() => {
    const element = scrollElementRef.current
    if (!element) return
    controllerRef.current?.anchorToEnd(element, virtualizer, conversation.length)
  }, [conversation.length, scrollElementRef, virtualizer])
  const jumpToIndex = useCallback((index: number, behavior: 'auto' | 'smooth') => {
    controllerRef.current?.jumpToIndex(virtualizer, index, behavior)
  }, [virtualizer])

  useLayoutEffect(() => {
    scrollToEnd()
  }, [conversation, interactionRevision, scrollToEnd])

  useLayoutEffect(() => {
    const content = contentElementRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null
        const element = scrollElementRef.current
        if (!element) return
        controllerRef.current?.realignAfterContentResize(
          element,
          virtualizer,
          conversation.length,
        )
      })
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = null
    }
  }, [contentElementRef, conversation.length, scrollElementRef, virtualizer])

  return { jumpToIndex }
}

export function anchorConversationToEnd(
  element: ConversationScrollElement,
  virtualizer: ConversationVirtualizer,
  itemCount: number,
): void {
  if (itemCount > 0) {
    virtualizer.scrollToIndex(itemCount - 1, { align: 'end', behavior: 'auto' })
  }
  element.scrollTop = element.scrollHeight
}

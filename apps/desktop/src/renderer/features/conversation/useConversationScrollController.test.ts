// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话末端滚动控制器测试
//
//   文件:       useConversationScrollController.test.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import {
  anchorConversationToEnd,
  ConversationScrollController,
} from './useConversationScrollController'

describe('anchorConversationToEnd', () => {
  it('从当前位置立即落到末端，不请求平滑重播', () => {
    const element = { scrollTop: 640, scrollHeight: 2_400 }
    const virtualizer = { scrollToIndex: vi.fn() }

    anchorConversationToEnd(element, virtualizer, 200)

    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(199, {
      align: 'end',
      behavior: 'auto',
    })
    expect(element.scrollTop).toBe(2_400)
  })

  it('空对话也只校正当前容器末端', () => {
    const element = { scrollTop: 320, scrollHeight: 480 }
    const virtualizer = { scrollToIndex: vi.fn() }

    anchorConversationToEnd(element, virtualizer, 0)

    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled()
    expect(element.scrollTop).toBe(480)
  })

  it('跳转轨道独占平滑导航，新互动再恢复强制到底', () => {
    const controller = new ConversationScrollController()
    const element = { scrollTop: 640, scrollHeight: 2_400 }
    const virtualizer = { scrollToIndex: vi.fn() }

    controller.jumpToIndex(virtualizer, 12, 'smooth')
    expect(virtualizer.scrollToIndex).toHaveBeenLastCalledWith(12, {
      align: 'center',
      behavior: 'smooth',
    })

    expect(controller.realignAfterContentResize(element, virtualizer, 200)).toBe(false)
    expect(element.scrollTop).toBe(640)

    controller.anchorToEnd(element, virtualizer, 200)
    expect(element.scrollTop).toBe(2_400)
    expect(controller.realignAfterContentResize(element, virtualizer, 200)).toBe(true)
    expect(virtualizer.scrollToIndex).toHaveBeenLastCalledWith(199, {
      align: 'end',
      behavior: 'auto',
    })
  })
})

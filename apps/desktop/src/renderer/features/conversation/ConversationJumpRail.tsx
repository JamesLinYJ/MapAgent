// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话跳转轨道
//
//   文件:       ConversationJumpRail.tsx
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import * as Popover from '@radix-ui/react-popover'
import { AnimatePresence,m } from 'framer-motion'
import { useReducer,useRef,type FocusEvent,type PointerEvent } from 'react'
import type { ConversationJumpItem } from './conversationJumpItems'
import {
conversationJumpRailReducer,
initialConversationJumpRailInteraction,
type ConversationJumpRailAction,
} from './conversationJumpRailState'

interface ConversationJumpRailProps {
  items: ConversationJumpItem[]
  activeAnchorId: string | null
  onJump: (anchorId: string) => void
}

export function ConversationJumpRail({ items, activeAnchorId, onJump }: ConversationJumpRailProps) {
  const [interaction, dispatch] = useReducer(
    conversationJumpRailReducer,
    initialConversationJumpRailInteraction,
  )
  const railRef = useRef<HTMLElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const isOpen = interaction.hovered || interaction.pinned

  if (items.length < 2) return null

  const activeItem = items.find(item => item.anchorId === activeAnchorId) ?? items.at(-1)

  return (
    <Popover.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) dispatch({ type: 'dismiss' })
      }}
    >
      <aside
        ref={railRef}
        className={`cc-jump-rail ${isOpen ? 'cc-jump-rail--open' : ''}`}
        aria-label="对话跳转"
      >
        <Popover.Anchor asChild>
          <button
            className="cc-jump-rail__toggle"
            type="button"
            aria-label={interaction.pinned ? '关闭对话跳转列表' : '打开并固定对话跳转列表'}
            aria-expanded={isOpen}
            aria-controls="cc-jump-rail-list"
            onClick={() => dispatch({ type: 'toggle-pin' })}
            onFocus={() => dispatch({ type: 'enter' })}
            onBlur={event => handleInteractionExit(event, popoverRef.current, dispatch)}
            onPointerEnter={() => dispatch({ type: 'enter' })}
            onPointerLeave={event => handleInteractionExit(event, popoverRef.current, dispatch)}
          >
            <span className="sr-only">打开对话跳转列表</span>
            <span className="cc-jump-rail__ticks" aria-hidden="true">
              {items.map(item => (
                <span
                  key={item.anchorId}
                  className={`cc-jump-rail__tick ${item.anchorId === activeItem?.anchorId ? 'cc-jump-rail__tick--active' : ''}`}
                />
              ))}
            </span>
          </button>
        </Popover.Anchor>

        <AnimatePresence>
          {isOpen && (
            <Popover.Portal forceMount>
              <Popover.Content
                side="right"
                align="center"
                sideOffset={0}
                collisionPadding={16}
                asChild
                forceMount
                onOpenAutoFocus={event => event.preventDefault()}
                onCloseAutoFocus={event => event.preventDefault()}
              >
                <m.div
                  ref={popoverRef}
                  id="cc-jump-rail-list"
                  className="ui-popover-surface cc-jump-rail__popover"
                  data-ui-surface="glass"
                  role="listbox"
                  aria-label="用户提问索引"
                  initial={{ opacity: 0, x: -8, scale: 0.98 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: -6, scale: 0.985 }}
                  transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                  onFocus={() => dispatch({ type: 'enter' })}
                  onBlur={event => handleInteractionExit(event, railRef.current, dispatch)}
                  onPointerEnter={() => dispatch({ type: 'enter' })}
                  onPointerLeave={event => handleInteractionExit(event, railRef.current, dispatch)}
                >
                  <div className="cc-jump-rail__head">
                    <strong>对话索引</strong>
                    <span>{items.length} 条提问</span>
                  </div>
                  <div className="cc-jump-rail__list">
                    {items.map(item => (
                      <button
                        key={item.anchorId}
                        type="button"
                        className={`cc-jump-rail__item ${item.anchorId === activeItem?.anchorId ? 'cc-jump-rail__item--active' : ''}`}
                        role="option"
                        aria-selected={item.anchorId === activeItem?.anchorId}
                        title={item.label}
                        onClick={() => {
                          onJump(item.anchorId)
                          dispatch({ type: 'dismiss' })
                        }}
                      >
                        <span>{item.sequence}</span>
                        <strong>{item.label}</strong>
                      </button>
                    ))}
                  </div>
                </m.div>
              </Popover.Content>
            </Popover.Portal>
          )}
        </AnimatePresence>
      </aside>
    </Popover.Root>
  )
}

function handleInteractionExit(
  event: PointerEvent<HTMLElement> | FocusEvent<HTMLElement>,
  connectedSurface: HTMLElement | null,
  dispatch: (action: ConversationJumpRailAction) => void,
): void {
  const nextTarget = event.relatedTarget
  if (nextTarget instanceof Node && connectedSurface?.contains(nextTarget)) return
  dispatch({ type: 'leave' })
}

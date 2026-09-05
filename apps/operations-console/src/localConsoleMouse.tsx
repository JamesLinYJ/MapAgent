// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本地运维台鼠标命中层
//
//   文件:       localConsoleMouse.tsx
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  createContext,
  type PropsWithChildren,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { Box, measureElement, type BoxProps, type DOMElement } from 'ink'

import type { TerminalMouseEvent, TerminalMouseSource } from './terminalMouse.js'

interface MouseRegionHandlers {
  disabled: boolean
  onClick: ((event: TerminalMouseEvent) => void) | undefined
  onWheel: ((direction: -1 | 1, event: TerminalMouseEvent) => void) | undefined
}

interface MouseRegionRecord {
  id: string
  order: number
  priority: number
  ref: RefObject<DOMElement | null>
  handlers: RefObject<MouseRegionHandlers>
}

interface MouseContextValue {
  enabled: boolean
  hoveredId: string | null
  pressedId: string | null
  register: (region: Omit<MouseRegionRecord, 'order'>) => () => void
}

const MouseContext = createContext<MouseContextValue | null>(null)

export function LocalConsoleMouseProvider({
  source,
  children,
}: PropsWithChildren<{ source: TerminalMouseSource | undefined }>) {
  const regions = useRef(new Map<string, MouseRegionRecord>())
  const nextOrder = useRef(0)
  const pressedIdRef = useRef<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [pressedId, setPressedId] = useState<string | null>(null)

  const register = useCallback((region: Omit<MouseRegionRecord, 'order'>): (() => void) => {
    const record: MouseRegionRecord = { ...region, order: nextOrder.current++ }
    regions.current.set(record.id, record)
    return () => {
      regions.current.delete(record.id)
      if (pressedIdRef.current === record.id) pressedIdRef.current = null
    }
  }, [])

  useLayoutEffect(() => {
    if (!source?.enabled) return
    return source.subscribe(event => {
      const target = findMouseRegion(regions.current, event, event.kind === 'wheel' ? 'wheel' : 'click')
      setHoveredId(target?.id ?? null)

      if (event.kind === 'wheel') {
        const direction = event.deltaY < 0 ? -1 : 1
        target?.handlers.current.onWheel?.(direction, event)
        return
      }
      if (event.button !== 'left') return
      if (event.kind === 'press') {
        pressedIdRef.current = target?.id ?? null
        setPressedId(pressedIdRef.current)
        return
      }
      if (event.kind === 'release') {
        const pressedRegionId = pressedIdRef.current
        pressedIdRef.current = null
        setPressedId(null)
        if (pressedRegionId && pressedRegionId === target?.id) {
          target.handlers.current.onClick?.(event)
        }
      }
    })
  }, [source])

  const value = useMemo<MouseContextValue>(() => ({
    enabled: Boolean(source?.enabled),
    hoveredId,
    pressedId,
    register,
  }), [hoveredId, pressedId, register, source?.enabled])

  return <MouseContext.Provider value={value}>{children}</MouseContext.Provider>
}

export interface MouseRegionState {
  enabled: boolean
  hovered: boolean
  pressed: boolean
}

type MouseRegionProps = Omit<BoxProps, 'children'> & {
  children: ReactNode | ((state: MouseRegionState) => ReactNode)
  disabled?: boolean
  priority?: number
  onClick?: (event: TerminalMouseEvent) => void
  onWheel?: (direction: -1 | 1, event: TerminalMouseEvent) => void
}

/** 可点击区域只负责命中与状态反馈，不直接承载业务权限或命令。 */
export function MouseRegion({
  children,
  disabled = false,
  priority = 0,
  onClick,
  onWheel,
  ...boxProps
}: MouseRegionProps) {
  const context = useContext(MouseContext)
  const id = useId()
  const ref = useRef<DOMElement | null>(null)
  const handlers = useRef<MouseRegionHandlers>({ disabled, onClick, onWheel })
  handlers.current = { disabled, onClick, onWheel }

  useLayoutEffect(() => context?.register({ id, priority, ref, handlers }), [context?.register, id, priority])

  const state: MouseRegionState = {
    enabled: Boolean(context?.enabled && !disabled),
    hovered: context?.hoveredId === id && !disabled,
    pressed: context?.pressedId === id && !disabled,
  }

  return (
    <Box ref={ref} {...boxProps}>
      {typeof children === 'function' ? children(state) : children}
    </Box>
  )
}

function findMouseRegion(
  regions: ReadonlyMap<string, MouseRegionRecord>,
  event: TerminalMouseEvent,
  capability: 'click' | 'wheel',
): MouseRegionRecord | null {
  const x = event.column - 1
  const y = event.row - 1
  const candidates = [...regions.values()]
    .filter(region => {
      if (region.handlers.current.disabled || !region.ref.current) return false
      return capability === 'wheel'
        ? Boolean(region.handlers.current.onWheel)
        : Boolean(region.handlers.current.onClick)
    })
    .sort((left, right) => right.priority - left.priority || right.order - left.order)

  for (const region of candidates) {
    if (!region.ref.current) continue
    const metrics = measureElement(region.ref.current)
    if (metrics.width <= 0 || metrics.height <= 0) continue
    if (x >= metrics.x && x < metrics.x + metrics.width && y >= metrics.y && y < metrics.y + metrics.height) {
      return region
    }
  }
  return null
}

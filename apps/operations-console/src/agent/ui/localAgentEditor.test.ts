// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 终端编辑器测试
//
//   文件:       localAgentEditor.test.ts
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  agentInputGraphemes,
  agentInputViewport,
  insertAgentInput,
  moveAgentInputVertical,
  navigateAgentInputHistory,
  normalizeAgentPaste,
  removeAgentInputBefore,
} from './localAgentEditor.js'

describe('local Agent terminal editor', () => {
  it('treats emoji sequences and Chinese characters as complete cursor units', () => {
    const value = '甲👩‍🌧️乙'
    expect(agentInputGraphemes(value)).toEqual(['甲', '👩‍🌧️', '乙'])

    const inserted = insertAgentInput({ value, cursorIndex: 2 }, '好', 10)
    expect(inserted).toEqual({ value: '甲👩‍🌧️好乙', cursorIndex: 3 })
    expect(removeAgentInputBefore(inserted)).toEqual({ value, cursorIndex: 2 })
  })

  it('moves vertically using terminal cell width instead of UTF-16 length', () => {
    const edit = { value: '甲乙丙丁\n123456', cursorIndex: 2 }
    const moved = moveAgentInputVertical(edit, 1, 8)
    expect(moved?.cursorIndex).toBe(9)
    expect(moveAgentInputVertical({ ...edit, cursorIndex: 0 }, -1, 8)).toBeNull()
  })

  it('walks repeatedly through history and restores the unsent draft', () => {
    let state = { index: null as number | null, draft: '' }
    let edit = { value: '没发送的草稿', cursorIndex: 7 }
    ;({ edit, state } = navigateAgentInputHistory({
      edit, state, history: ['第一条', '第二条', '第三条'], direction: -1,
    }))
    expect(edit.value).toBe('第三条')
    ;({ edit, state } = navigateAgentInputHistory({
      edit, state, history: ['第一条', '第二条', '第三条'], direction: -1,
    }))
    expect(edit.value).toBe('第二条')
    ;({ edit, state } = navigateAgentInputHistory({
      edit, state, history: ['第一条', '第二条', '第三条'], direction: 1,
    }))
    ;({ edit, state } = navigateAgentInputHistory({
      edit, state, history: ['第一条', '第二条', '第三条'], direction: 1,
    }))
    expect(edit.value).toBe('没发送的草稿')
    expect(state.index).toBeNull()
  })

  it('keeps the cursor inside a bounded multiline viewport', () => {
    const value = Array.from({ length: 12 }, (_, index) => `第${index}行`).join('\n')
    const viewport = agentInputViewport({ value, cursorIndex: agentInputGraphemes(value).length }, 20, 3)
    expect(viewport.visibleRows).toBe(3)
    expect(viewport.clippedBefore).toBe(true)
    expect(viewport.before).toContain('第9行')
    expect(viewport.before).not.toContain('第0行')
  })

  it('keeps pasted lines while removing terminal controls, NUL and unstable tabs', () => {
    expect(normalizeAgentPaste(
      '第一行\r\n第二\t列\u0000\u0007\u001b[31m红色\u001b[0m\r第三行\u007f',
    )).toBe('第一行\n第二    列红色\n第三行')
  })
})

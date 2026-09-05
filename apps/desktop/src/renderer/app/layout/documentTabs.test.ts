// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面文档标签状态测试
//
//   文件:       documentTabs.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  closeDesktopDocument,
  isFocusedDesktopDocument,
  moveDesktopDocument,
  openDesktopDocument,
  stepDesktopDocument,
} from './documentTabs'

describe('desktop document tabs', () => {
  it('keeps the map pinned and opens each document only once', () => {
    expect(openDesktopDocument(['map', 'tools'], 'workflow'))
      .toEqual(['map', 'tools', 'workflow'])
    expect(openDesktopDocument(['map', 'tools'], 'tools'))
      .toEqual(['map', 'tools'])
    expect(openDesktopDocument(['map'], 'privacy'))
      .toEqual(['map', 'privacy'])
  })

  it('selects an adjacent tab when the active document closes', () => {
    expect(closeDesktopDocument(
      ['map', 'tools', 'workflow', 'results'],
      'workflow',
      'workflow',
    )).toEqual({
      documents: ['map', 'tools', 'results'],
      activeDocument: 'results',
    })
    expect(closeDesktopDocument(['map', 'tools'], 'tools', 'tools')).toEqual({
      documents: ['map'],
      activeDocument: 'map',
    })
  })

  it('reorders closable tabs without moving the pinned map', () => {
    expect(moveDesktopDocument(
      ['map', 'tools', 'workflow', 'results'],
      'results',
      'tools',
    )).toEqual(['map', 'results', 'tools', 'workflow'])
    expect(stepDesktopDocument(
      ['map', 'tools', 'workflow'],
      'workflow',
      -1,
    )).toEqual(['map', 'workflow', 'tools'])
    expect(moveDesktopDocument(['map', 'tools'], 'tools', 'map'))
      .toEqual(['map', 'tools'])
  })

  it('reserves the full document canvas for page-style documents', () => {
    expect(['settings', 'account', 'security', 'debug', 'terms', 'privacy']
      .every(document => isFocusedDesktopDocument(document as Parameters<typeof isFocusedDesktopDocument>[0])))
      .toBe(true)
    expect(isFocusedDesktopDocument('map')).toBe(false)
    expect(isFocusedDesktopDocument('tools')).toBe(false)
    expect(isFocusedDesktopDocument('workflow')).toBe(false)
    expect(isFocusedDesktopDocument('results')).toBe(false)
  })
})

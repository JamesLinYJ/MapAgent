// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 数据绑定测试
//
//   文件:       automationBindings.test.ts
//
//   日期:       2026年07月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { resolveAutomationBinding } from './automationBindings.js'

describe('resolveAutomationBinding', () => {
  it('selects exactly one valueRef by semantic kind', () => {
    const resolved = resolveAutomationBinding({
      source: 'value_ref',
      nodeId: 'files',
      kind: 'meteorological_file_collection',
      path: 'refId',
    }, {
      prompt: '检查文件',
      parameters: {},
      nodeOutputs: {
        files: {
          valueRefs: [
            { refId: 'ref_file', kind: 'meteorological_file' },
            { refId: 'ref_collection', kind: 'meteorological_file_collection' },
          ],
        },
      },
    })

    expect(resolved).toBe('ref_collection')
  })

  it('fails when a valueRef kind is missing or ambiguous', () => {
    const base = {
      prompt: '检查文件',
      parameters: {},
      nodeOutputs: { files: { valueRefs: [] as unknown[] } },
    }
    const binding = {
      source: 'value_ref' as const,
      nodeId: 'files',
      kind: 'meteorological_file_collection',
      path: 'refId',
    }

    expect(() => resolveAutomationBinding(binding, base)).toThrow('没有 kind')
    base.nodeOutputs.files.valueRefs = [
      { refId: 'ref_a', kind: 'meteorological_file_collection' },
      { refId: 'ref_b', kind: 'meteorological_file_collection' },
    ]
    expect(() => resolveAutomationBinding(binding, base)).toThrow('绑定结果不唯一')
  })
})

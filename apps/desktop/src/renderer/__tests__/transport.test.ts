// +-------------------------------------------------------------------------
//
//   地理智能平台 - 传输层纯函数测试
//
//   文件:       transport.test.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       Claude Code:Opus 4.8
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { wsCommandContracts, wsControlCommands } from '@geo-agent-platform/shared-types'
import { formatSchemaValidationError } from '../api/transport'

describe('formatSchemaValidationError', () => {
  it('formats single issue with root path', () => {
    const result = formatSchemaValidationError('bootstrap', [
      { path: [], message: 'Required' },
    ])
    expect(result).toContain('平台协议')
    expect(result).toContain('bootstrap')
    expect(result).toContain('(根)')
    expect(result).toContain('Required')
  })

  it('formats nested path issues', () => {
    const result = formatSchemaValidationError('workspace', [
      { path: ['layers', 0, 'name'], message: 'Expected string' },
    ])
    expect(result).toContain('layers.0.name')
    expect(result).toContain('Expected string')
  })

  it('truncates at 5 issues', () => {
    const issues = Array.from({ length: 10 }, (_, i) => ({
      path: [`field_${i}`],
      message: `Error ${i}`,
    }))
    const result = formatSchemaValidationError('test', issues)
    const errorCount = (result.match(/Error \d/g) || []).length
    expect(errorCount).toBe(5)
  })

  it('handles empty issues gracefully', () => {
    const result = formatSchemaValidationError('empty', [])
    expect(result).toContain('empty')
  })
})

// 测试 ResponseSchema 接口的类型安全
// 这是编译期验证——如果 safeParse 的签名不匹配，TypeScript 会报错。
// 此处用运行时验证来确保 safeParse 的模式可用。
describe('ResponseSchema interface (contract)', () => {
  it('safeParse success returns typed data', () => {
    const schema = {
      safeParse: (data: unknown) => {
        if (typeof data === 'string') return { success: true as const, data }
        return { success: false as const, error: { issues: [{ path: [], message: 'not string' }] } }
      },
    }
    const result = schema.safeParse('hello')
    if (result.success) {
      expect(result.data).toBe('hello')
    }
  })

  it('safeParse failure returns structured error', () => {
    const schema = {
      safeParse: (data: unknown) => {
        if (typeof data === 'number') return { success: true as const, data }
        return { success: false as const, error: { issues: [{ path: ['body'], message: 'not number' }] } }
      },
    }
    const result = schema.safeParse('not-a-number')
    if (!result.success) {
      expect(result.error.issues.at(0)?.path).toEqual(['body'])
    }
  })
})

describe('WebSocket command contract map', () => {
  it('covers every protocol command with payload and response schemas', () => {
    const compareCommands = (left: string, right: string) => left.localeCompare(right)
    expect(Object.keys(wsCommandContracts).sort(compareCommands))
      .toEqual([...wsControlCommands].sort(compareCommands))
    for (const type of wsControlCommands) {
      expect(wsCommandContracts[type].payload).toBeDefined()
      expect(wsCommandContracts[type].response).toBeDefined()
      expect(typeof wsCommandContracts[type].csrf).toBe('boolean')
    }
  })
})

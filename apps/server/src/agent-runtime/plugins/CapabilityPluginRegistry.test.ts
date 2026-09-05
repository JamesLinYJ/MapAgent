// +-------------------------------------------------------------------------
//
//   地理智能平台 - Capability Plugin 注册表测试
//
//   文件:       CapabilityPluginRegistry.test.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { CapabilityPluginRegistry } from './CapabilityPluginRegistry.js'

describe('CapabilityPluginRegistry', () => {
  it('binds an explicitly registered capability package only to existing permissions', () => {
    const snapshot = new CapabilityPluginRegistry({
      enabled: true,
      registrations: [{
        pluginId: 'quality-pack',
        enabled: true,
        version: '1.0.0',
        source: 'platform:quality-pack',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        bindings: {
          toolNames: ['list_layers'],
          mcpServerNames: ['docs'],
          skillIds: ['crs-audit'],
          hookIds: ['audit-hook'],
          writableRoots: ['/workspace/output'],
        },
      }],
    }).resolve({
      toolNames: ['list_layers', 'query_layer'],
      mcpServerNames: ['docs'],
      skillIds: ['crs-audit'],
      hookIds: ['audit-hook'],
      writableRoots: ['/workspace'],
    })

    expect(snapshot.pluginIds).toEqual(['quality-pack'])
    expect(snapshot.bindings[0]).toMatchObject({
      pluginId: 'quality-pack',
      toolNames: ['list_layers'],
      writableRoots: ['/workspace/output'],
    })
    expect(Object.isFrozen(snapshot.bindings)).toBe(true)
  })

  it('hard-fails tool and path permission expansion', () => {
    const base = {
      toolNames: ['list_layers'],
      mcpServerNames: [],
      skillIds: [],
      hookIds: [],
      writableRoots: ['/workspace/output'],
    }
    const registration = {
      pluginId: 'unsafe-pack',
      enabled: true,
      version: '1.0.0',
      source: 'platform:unsafe-pack',
      contentDigest: `sha256:${'b'.repeat(64)}`,
      bindings: {
        toolNames: ['delete_layer'],
        mcpServerNames: [],
        skillIds: [],
        hookIds: [],
        writableRoots: [],
      },
    }
    expect(() => new CapabilityPluginRegistry({ enabled: true, registrations: [registration] }).resolve(base))
      .toThrow(/扩大 tool 权限/u)

    registration.bindings.toolNames = []
    registration.bindings.writableRoots = ['/workspace']
    expect(() => new CapabilityPluginRegistry({ enabled: true, registrations: [registration] }).resolve(base))
      .toThrow(/扩大 writable root/u)
  })
})

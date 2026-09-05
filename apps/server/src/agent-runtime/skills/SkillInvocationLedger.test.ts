// +-------------------------------------------------------------------------
//
//   地理智能平台 - Skill invocation ledger 测试
//
//   文件:       SkillInvocationLedger.test.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { defaultRuntimeConfig } from '../../agent/defaultRuntimeConfig.js'
import { buildSkillRegistry, searchSkillRegistry } from '../../agent/skillRegistry.js'
import { buildSkillInvocationLedger } from './SkillInvocationLedger.js'

describe('SkillInvocationLedger', () => {
  it('records explicit and deterministic implicit invocation modes with full metadata', () => {
    const config = defaultRuntimeConfig().sdk.skills
    config.enabled = true
    const registry = buildSkillRegistry(config, process.cwd())
    const explicitMatches = searchSkillRegistry('/crs-audit', registry)
    const explicitSkill = registry.skills.filter(skill => skill.catalog.skillId === 'crs-audit')
    const explicit = buildSkillInvocationLedger({ selected: explicitSkill, matches: explicitMatches })
    const implicitMatches = searchSkillRegistry('请先做坐标系审计', registry)
    const implicit = buildSkillInvocationLedger({ selected: explicitSkill, matches: implicitMatches })

    expect(explicit[0]).toMatchObject({
      skillId: 'crs-audit',
      version: '1.0.0',
      mode: 'explicit',
      trustStatus: 'builtin',
      requiredCapabilities: ['layer-metadata', 'read-only-analysis'],
    })
    expect(implicit[0]?.mode).toBe('implicit')
    expect(explicit[0]?.invocationId).not.toBe(implicit[0]?.invocationId)
    expect(buildSkillInvocationLedger({ selected: explicitSkill, matches: explicitMatches }))
      .toEqual(explicit)
  })

  it('distinguishes profile and plugin bindings without granting permissions', () => {
    const config = defaultRuntimeConfig().sdk.skills
    config.enabled = true
    const skill = buildSkillRegistry(config, process.cwd()).skills
      .find(candidate => candidate.catalog.skillId === 'analysis-report')
    if (!skill) throw new Error('analysis-report missing')

    expect(buildSkillInvocationLedger({ selected: [skill], matches: [] })[0]?.mode).toBe('profile')
    expect(buildSkillInvocationLedger({
      selected: [skill],
      matches: [],
      pluginSkillIds: new Set(['analysis-report']),
    })[0]?.mode).toBe('plugin')
  })
})

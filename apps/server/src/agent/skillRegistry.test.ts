// +-------------------------------------------------------------------------
//
//   地理智能平台 - GIS Skill 注册表测试
//
//   文件:       skillRegistry.test.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import {
  buildSkillRegistry,
  searchSkillRegistry,
  selectRuntimeSkills,
} from './skillRegistry.js'

describe('GIS Skill registry', () => {
  it('publishes the six built-in GIS skills with pinned built-in trust', () => {
    const config = defaultRuntimeConfig().sdk.skills
    const registry = buildSkillRegistry(config, process.cwd())

    expect(registry.snapshot.entries.map(skill => skill.skillId)).toEqual(expect.arrayContaining([
      'crs-audit',
      'spatial-data-quality',
      'cartographic-delivery',
      'remote-sensing-raster-check',
      'meteorological-data-check',
      'analysis-report',
    ]))
    expect(registry.snapshot.entries).toHaveLength(6)
    expect(registry.snapshot.entries.every(skill => skill.trustStatus === 'builtin')).toBe(true)
    expect(registry.snapshot.entries.every(skill => skill.active === false)).toBe(true)
  })

  it('routes explicit and exact aliases deterministically', () => {
    const config = defaultRuntimeConfig().sdk.skills
    config.enabled = true
    const registry = buildSkillRegistry(config, process.cwd())

    expect(searchSkillRegistry('/crs-audit 检查图层', registry)[0]).toMatchObject({
      skillId: 'crs-audit',
      matchKind: 'explicit',
      score: 1,
      autoLoad: true,
    })
    expect(searchSkillRegistry('请先做坐标系审计', registry)[0]).toMatchObject({
      skillId: 'crs-audit',
      matchKind: 'exact',
      autoLoad: true,
    })
  })

  it('shows low-confidence relevance candidates without auto loading them', () => {
    const config = defaultRuntimeConfig().sdk.skills
    config.enabled = true
    config.autoMatchThreshold = 1
    const registry = buildSkillRegistry(config, process.cwd())
    const matches = searchSkillRegistry('检查数据异常并说明范围', registry)

    expect(matches.length).toBeGreaterThan(0)
    expect(matches.some(match => match.matchKind === 'relevance')).toBe(true)
    expect(matches.every(match => match.autoLoad === false)).toBe(true)
    expect(matches[0]?.reason).toContain('命中词项')
  })

  it('pins external content and invalidates trust when a loaded resource changes', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'geo-skill-registry-digest-')))
    try {
      const skillDir = path.join(root, 'external-check')
      await mkdir(path.join(skillDir, 'references'), { recursive: true })
      await writeFile(path.join(skillDir, 'SKILL.md'), externalSkillMarkdown())
      await writeFile(path.join(skillDir, 'references', 'rules.md'), 'version one')
      const config = defaultRuntimeConfig().sdk.skills
      config.enabled = true
      config.skillPaths = [skillDir]

      const untrusted = buildSkillRegistry(config, process.cwd())
      const external = requireSkill(untrusted, 'external-check')
      expect(external.catalog).toMatchObject({ trustStatus: 'untrusted', active: false })
      expect(() => selectRuntimeSkills('/external-check', untrusted)).toThrow('尚未信任')

      config.registrations = [{
        skillId: 'external-check',
        enabled: true,
        trustedDigest: external.catalog.contentDigest,
      }]
      const trusted = buildSkillRegistry(config, process.cwd())
      expect(requireSkill(trusted, 'external-check').catalog).toMatchObject({ trustStatus: 'trusted', active: true })

      await writeFile(path.join(skillDir, 'references', 'rules.md'), 'version two')
      const changed = buildSkillRegistry(config, process.cwd())
      expect(requireSkill(changed, 'external-check').catalog).toMatchObject({
        trustStatus: 'content_changed',
        active: false,
      })
      expect(changed.snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'skill_digest_changed' }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports wrong casing without hiding the rest of the catalog', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'geo-skill-registry-case-')))
    try {
      const skillDir = path.join(root, 'wrong-case')
      await mkdir(skillDir, { recursive: true })
      await writeFile(path.join(skillDir, 'skill.md'), '# wrong')
      const config = defaultRuntimeConfig().sdk.skills
      config.skillPaths = [skillDir]

      expect(() => buildSkillRegistry(config, process.cwd())).toThrow('大小写必须严格为 SKILL.md')
      const tolerant = buildSkillRegistry(config, process.cwd(), { strict: false })
      expect(tolerant.snapshot.entries).toHaveLength(6)
      expect(tolerant.snapshot.diagnostics[0]).toMatchObject({ code: 'skill_discovery_error' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate names and symlinked resources', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'geo-skill-registry-security-')))
    try {
      const duplicateDir = path.join(root, 'duplicate')
      await mkdir(duplicateDir, { recursive: true })
      await writeFile(path.join(duplicateDir, 'SKILL.md'), [
        '---',
        'id: duplicate-crs',
        'name: CRS 审计',
        '---',
      ].join('\n'))
      const duplicateConfig = defaultRuntimeConfig().sdk.skills
      duplicateConfig.skillPaths = [duplicateDir]
      expect(() => buildSkillRegistry(duplicateConfig, process.cwd())).toThrow('Skill 冲突')

      const symlinkDir = path.join(root, 'symlinked')
      await mkdir(path.join(symlinkDir, 'assets'), { recursive: true })
      await writeFile(path.join(symlinkDir, 'SKILL.md'), externalSkillMarkdown('symlinked'))
      await writeFile(path.join(root, 'outside.txt'), 'outside')
      await symlink(path.join(root, 'outside.txt'), path.join(symlinkDir, 'assets', 'outside.txt'))
      const symlinkConfig = defaultRuntimeConfig().sdk.skills
      symlinkConfig.skillPaths = [symlinkDir]
      expect(() => buildSkillRegistry(symlinkConfig, process.cwd())).toThrow('不能包含符号链接')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function externalSkillMarkdown(skillId = 'external-check'): string {
  return [
    '---',
    `id: ${skillId}`,
    `name: ${skillId}`,
    'version: 2.1.0',
    'description: 检查外部空间数据。',
    'aliases: [external audit, 外部审计]',
    'tags: [gis, external]',
    'capabilities: [layer-query]',
    '---',
    '',
    '# External check',
  ].join('\n')
}

function requireSkill(registry: ReturnType<typeof buildSkillRegistry>, skillId: string) {
  const skill = registry.skills.find(candidate => candidate.catalog.skillId === skillId)
  if (!skill) throw new Error(`Skill '${skillId}' missing`)
  return skill
}

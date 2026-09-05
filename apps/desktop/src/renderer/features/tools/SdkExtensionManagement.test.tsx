// +-------------------------------------------------------------------------
//
//   地理智能平台 - SDK Skill 注册表界面测试
//
//   文件:       SdkExtensionManagement.test.tsx
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  agentRuntimeConfigSchema,
  skillCatalogSnapshotSchema,
  type SkillMatchResult,
} from '@geo-agent-platform/shared-types'
import { SdkExtensionManagement } from './SdkExtensionManagement'

describe('SdkExtensionManagement Skill registry', () => {
  it('renders source, digest, trust action and explainable routing results', () => {
    const config = agentRuntimeConfigSchema.parse({
      sandbox: { backend: 'unix_local' },
      sdk: { skills: { enabled: true } },
    })
    const catalog = skillCatalogSnapshotSchema.parse({
      globalEnabled: true,
      autoMatchThreshold: 0.72,
      candidateThreshold: 0.12,
      diagnostics: [{
        code: 'skill_untrusted',
        message: '外部审计：尚未信任。',
        sourceLabel: 'skills/external-audit',
        skillId: 'external-audit',
      }],
      entries: [{
        skillId: 'external-audit',
        name: '外部审计',
        version: '2.0.0',
        description: '检查外部空间数据。',
        aliases: ['external check'],
        tags: ['gis', 'quality'],
        capabilityRequirements: ['layer-query'],
        source: { kind: 'direct', label: 'skills/external-audit' },
        contentDigest: `sha256:${'a'.repeat(64)}`,
        enabled: true,
        trustStatus: 'untrusted',
        active: false,
        diagnostic: '外部 Skill 尚未固定内容摘要。',
      }],
    })
    const matches: SkillMatchResult[] = [{
      skillId: 'external-audit',
      name: '外部审计',
      score: 0.54,
      matchKind: 'relevance',
      reason: '描述命中词项：外部、审计。',
      autoLoad: false,
      trustStatus: 'untrusted',
      enabled: true,
    }]

    const html = renderToStaticMarkup(
      <SdkExtensionManagement
        view="skills"
        runtimeConfig={config}
        skillCatalog={catalog}
        skillSearchResults={matches}
      />,
    )

    expect(html).toContain('GIS Skill 注册表')
    expect(html).toContain('外部审计')
    expect(html).toContain('skills/external-audit')
    expect(html).toContain('sha256:aaaaaaaaaaaa')
    expect(html).toContain('仅候选')
    expect(html).toContain('信任此摘要')
  })
})

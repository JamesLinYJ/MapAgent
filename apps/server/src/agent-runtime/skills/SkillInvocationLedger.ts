// +-------------------------------------------------------------------------
//
//   地理智能平台 - Skill invocation ledger
//
//   文件:       SkillInvocationLedger.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentSkillInvocation } from '@geo-agent-platform/shared-types/agent-step-context'
import type { SkillMatchResult } from '@geo-agent-platform/shared-types/resources'

import type { RegisteredSkill } from '../../agent/skillRegistry.js'
import { agentContextDigest } from '../step/agentContextDigest.js'

export interface BuildSkillInvocationLedgerInput {
  selected: readonly RegisteredSkill[]
  matches: readonly SkillMatchResult[]
  pluginSkillIds?: ReadonlySet<string>
}

/**
 * 将“为什么本 Step 看见这个 Skill”固化为可持久化事实。该 ledger 只描述
 * instructions/workspace 候选，不授予工具、路径或网络权限。
 */
export function buildSkillInvocationLedger(
  input: BuildSkillInvocationLedgerInput,
): AgentSkillInvocation[] {
  const matches = new Map(input.matches.map(match => [match.skillId, match]))
  return input.selected
    .map(skill => {
      const match = matches.get(skill.catalog.skillId)
      const mode: AgentSkillInvocation['mode'] = match?.matchKind === 'explicit'
        ? 'explicit'
        : input.pluginSkillIds?.has(skill.catalog.skillId)
          ? 'plugin'
          : match
            ? 'implicit'
            : 'profile'
      const reason = match?.reason
        ?? (mode === 'plugin'
          ? '显式注册的 Plugin 绑定了该 Skill。'
          : 'Run Profile 固定启用了该 Skill。')
      const identity = {
        skillId: skill.catalog.skillId,
        version: skill.catalog.version,
        source: skill.catalog.source,
        contentDigest: skill.catalog.contentDigest,
        mode,
        reason,
      }
      return {
        invocationId: `skill_invocation_${agentContextDigest(identity).slice('sha256:'.length, 'sha256:'.length + 32)}`,
        skillId: skill.catalog.skillId,
        name: skill.catalog.name,
        version: skill.catalog.version,
        source: skill.catalog.source,
        contentDigest: skill.catalog.contentDigest,
        trustStatus: skill.catalog.trustStatus,
        requiredCapabilities: [...skill.catalog.capabilityRequirements].sort(),
        mode,
        reason,
      }
    })
    .sort((left, right) => left.skillId.localeCompare(right.skillId))
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 防腐边界架构守卫
//
//   文件:       agentsSdkBoundaryArchitecture.test.ts
//
//   日期:       2026年08月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Agents SDK anti-corruption boundary', () => {
  it('把 RunState 操作限制在 sdk/，并禁止解析 checkpoint 内部布局', async () => {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const files = await collectProductionTypescript(sourceRoot)
    const internalInputToken = '.' + '_' + 'originalInput'
    const generatedItemsToken = 'generated' + 'Items'

    for (const file of files) {
      const relative = path.relative(sourceRoot, file).replace(/\\/gu, '/')
      const source = await readFile(file, 'utf8')
      expect(source.includes(internalInputToken), relative).toBe(false)
      expect(source.includes(generatedItemsToken), relative).toBe(false)
      if (/import[\s\S]*?\bRunState\b[\s\S]*?from ['"]@openai\/agents['"]/u.test(source)) {
        expect(relative.startsWith('agent-runtime/sdk/'), relative).toBe(true)
      }
      expect(
        /JSON\.parse\([^)]*\.toString\(\)/u.test(source),
        relative,
      ).toBe(false)
    }

    await expect(stat(path.join(sourceRoot, 'agent/agentsSdkStateBoundary.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(sourceRoot, 'agent/agentsCheckpointService.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(sourceRoot, 'agent/fileAgentsSession.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(sourceRoot, 'agent-runtime/sdk/AgentsSdkBridge.ts')))
      .resolves.toMatchObject({})
    await expect(stat(path.join(sourceRoot, 'agent-runtime/sdk/AgentsSdkCheckpointCodec.ts')))
      .resolves.toMatchObject({})
    await expect(stat(path.join(sourceRoot, 'agent-runtime/sdk/CanonicalAgentsSession.ts')))
      .resolves.toMatchObject({})

    const assemblySource = await readFile(path.join(sourceRoot, 'agent/runtimeAssembly.ts'), 'utf8')
    expect(assemblySource.includes('projectSessionItems')).toBe(false)
    expect(assemblySource.includes('SDK Session 只保存 SDK 的 replay history')).toBe(true)
  })
})

async function collectProductionTypescript(root: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      output.push(...await collectProductionTypescript(absolute))
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    output.push(absolute)
  }
  return output
}

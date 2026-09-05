// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 凭据来源边界测试
//
//   文件:       desktopCredentialBoundary.test.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const mainDirectory = path.dirname(fileURLToPath(import.meta.url))
const sourceDirectory = path.resolve(mainDirectory, '..')
const desktopDirectory = path.resolve(sourceDirectory, '..')

describe('desktop credential source boundary', () => {
  it('禁止 Main 生产源码接入系统凭据存储或转发完整宿主环境', async () => {
    const source = (await Promise.all((await collectProductionSources(sourceDirectory)).map(file => (
      readFile(file, 'utf8')
    )))).join('\n')
    const forgeSource = await readFile(path.join(desktopDirectory, 'forge.config.mjs'), 'utf8')

    expect(source).not.toMatch(/\bsafeStorage\b|\bkeytar\b|\bKWallet\b|password-store/u)
    expect(source).not.toContain('collectDesktopLogSecrets')
    expect(source).not.toMatch(/\.\.\.\s*process\.env|(?:env|environment)\s*:\s*process\.env/u)
    expect(source).not.toContain("from '@better-auth/electron/client'")
    expect(source).not.toContain("from 'better-auth/client'")
    expect(source).not.toContain("from '@geo-agent-platform/operations-supervisor'")
    expect(source).not.toMatch(/\bdocument\.cookie\b|\bsession\.cookies\b/u)
    expect(forgeSource).toContain('[FuseV1Options.EnableCookieEncryption]: false')
    expect(forgeSource).toContain('[FuseV1Options.GrantFileProtocolExtraPrivileges]: false')
  })
})

async function collectProductionSources(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectProductionSources(target))
      continue
    }
    if (!/\.(?:ts|tsx)$/u.test(entry.name) || /\.test\.(?:ts|tsx)$/u.test(entry.name)) continue
    files.push(target)
  }
  return files
}

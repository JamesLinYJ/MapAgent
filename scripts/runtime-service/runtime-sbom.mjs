// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Service 软件物料清单
//
//   文件:       runtime-sbom.mjs
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { collectNpmProductionPackages } from './npm-packages.mjs'

export async function writeRuntimeSbom({ artifactRoot, npmLock, releaseId, repositoryRoot }) {
  const npmPackages = collectNpmProductionPackages(npmLock)
    .map(value => ({
      ecosystem: 'npm',
      name: value.name,
      version: value.version,
      downloadLocation: value.resolved ?? 'NOASSERTION',
    }))
  const pythonLock = await readFile(path.join(repositoryRoot, 'apps/worker/uv.lock'), 'utf8')
  const pythonPackages = [...pythonLock.matchAll(
    /\[\[package\]\]\s*name = "([^"]+)"\s*version = "([^"]+)"/gu,
  )].map(match => ({
    ecosystem: 'pypi',
    name: match[1],
    version: match[2],
    downloadLocation: 'NOASSERTION',
  }))
  const packages = [...npmPackages, ...pythonPackages]
    .sort((left, right) => {
      const leftKey = `${left.ecosystem}:${left.name}:${left.version}`
      const rightKey = `${right.ecosystem}:${right.name}:${right.version}`
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
    .map((entry, index) => ({
      SPDXID: `SPDXRef-Package-${index + 1}`,
      name: `${entry.ecosystem}:${entry.name}`,
      versionInfo: entry.version,
      downloadLocation: entry.downloadLocation,
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      supplier: 'NOASSERTION',
    }))
  const sbom = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: 'geo-agent-platform-runtime-service',
    documentNamespace: `https://geo-agent-platform.invalid/runtime-service/${encodeURIComponent(releaseId)}`,
    creationInfo: {
      created: resolveSbomCreatedAt(process.env),
      creators: ['Tool: geo-agent-platform runtime artifact builder'],
    },
    packages,
    relationships: packages.map(pkg => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: pkg.SPDXID,
    })),
  }
  await writeFile(
    path.join(artifactRoot, 'runtime-service-sbom.spdx.json'),
    `${JSON.stringify(sbom, null, 2)}\n`,
    'utf8',
  )
}

export function assertNpmSbomClosure(sbomPackages, expectedPackages) {
  const actual = new Set(sbomPackages
    .filter(entry => typeof entry?.name === 'string' && entry.name.startsWith('npm:'))
    .map(entry => `${entry.name.slice(4)}\u0000${String(entry.versionInfo)}`))
  const expected = new Set(expectedPackages.map(entry => `${entry.name}\u0000${entry.version}`))
  const missing = [...expected].filter(entry => !actual.has(entry))
  const unexpected = [...actual].filter(entry => !expected.has(entry))
  if (missing.length || unexpected.length) {
    throw new Error(
      `运行服务 SBOM 与 npm 生产依赖闭包不一致`
      + `（缺少 ${missing.length} 项，多出 ${unexpected.length} 项）。`,
    )
  }
}

function resolveSbomCreatedAt(environment) {
  const sourceDateEpoch = environment.SOURCE_DATE_EPOCH?.trim()
  if (!sourceDateEpoch) return new Date().toISOString()
  if (!/^\d+$/u.test(sourceDateEpoch)) {
    throw new Error('SOURCE_DATE_EPOCH 必须是非负 Unix 秒数。')
  }
  const timestamp = Number(sourceDateEpoch) * 1_000
  const date = new Date(timestamp)
  if (!Number.isFinite(timestamp) || Number.isNaN(date.valueOf())) {
    throw new Error('SOURCE_DATE_EPOCH 超出可支持时间范围。')
  }
  return date.toISOString()
}

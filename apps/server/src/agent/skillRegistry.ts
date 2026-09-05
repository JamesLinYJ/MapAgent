// +-------------------------------------------------------------------------
//
//   地理智能平台 - GIS Skill 注册表与确定性路由
//
//   文件:       skillRegistry.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 模块职责
//
// 从平台内置内容与显式配置的 SKILL.md 目录构建单一 Skill 注册表，
// 固定内容摘要与信任状态，并提供不依赖模型的显式/精确/BM25 路由。
// 注册表只决定哪些说明可被 SDK skills capability 看见；它不增加工具权限。

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { dir, file, type Entry } from '@openai/agents/sandbox'
import type {
  SkillCatalogDiagnostic,
  SkillCatalogEntry,
  SkillCatalogSnapshot,
  SkillMatchResult,
} from '@geo-agent-platform/shared-types/resources'
import type { RuntimeSkillConfig } from '@geo-agent-platform/shared-types/runtime'

interface SkillSource {
  kind: SkillCatalogEntry['source']['kind']
  label: string
}

export interface RegisteredSkill {
  catalog: SkillCatalogEntry
  manifestKey: string
  markdown: string
  absolutePath: string | null
}

export interface SkillRegistry {
  snapshot: SkillCatalogSnapshot
  skills: RegisteredSkill[]
}

interface RawSkill {
  skillId: string
  name: string
  version: string
  description: string
  aliases: string[]
  tags: string[]
  capabilityRequirements: string[]
  source: SkillSource
  contentDigest: string
  manifestKey: string
  markdown: string
  absolutePath: string | null
}

interface BuiltinSkillDefinition {
  skillId: string
  name: string
  version: string
  description: string
  aliases: string[]
  tags: string[]
  capabilityRequirements: string[]
  instructions: string
}

const BUILTIN_SKILLS: BuiltinSkillDefinition[] = [
  {
    skillId: 'crs-audit',
    name: 'CRS 审计',
    version: '1.0.0',
    description: '检查坐标参考系、轴顺序、单位和重投影前提。',
    aliases: ['坐标系审计', '投影检查', 'crs-check'],
    tags: ['gis', 'crs', 'quality'],
    capabilityRequirements: ['layer-metadata', 'read-only-analysis'],
    instructions: `# CRS 审计

1. 先读取图层和数据的真实 CRS/SRID，不根据坐标数值猜测。
2. 检查地理/投影坐标系、轴顺序、线性或角度单位与适用范围。
3. 跨图层分析前明确目标 CRS，记录重投影方法和可能误差。
4. 只使用平台已授权的工具和 valueRef；缺少元数据时稳定失败。`,
  },
  {
    skillId: 'spatial-data-quality',
    name: '空间数据质量',
    version: '1.0.0',
    description: '审计空间数据完整性、几何有效性、属性缺失和范围异常。',
    aliases: ['数据质检', '几何质量', 'spatial-qa'],
    tags: ['gis', 'quality', 'geometry'],
    capabilityRequirements: ['layer-query', 'read-only-analysis'],
    instructions: `# 空间数据质量

1. 记录要素数、几何类型、空值、重复值和关键属性完整度。
2. 检查无效几何、空几何、越界范围和显著异常值。
3. 区分可修复警告与会改变分析结论的阻断问题。
4. 未经用户批准不写回或修复原数据。`,
  },
  {
    skillId: 'cartographic-delivery',
    name: '制图交付',
    version: '1.0.0',
    description: '将已验证的空间分析结果组织为地图、图例与可下载成果。',
    aliases: ['地图出图', '制图成果', 'map-delivery'],
    tags: ['gis', 'cartography', 'delivery'],
    capabilityRequirements: ['map-artifact', 'artifact-delivery'],
    instructions: `# 制图交付

1. 只使用已验证的图层和分析 valueRef 制图。
2. 明确标题、图例、比例尺、方向、数据时间与来源，并保证分类符号可解释。
3. 交付前检查范围、遮挡、颜色对比与下载 Artifact 状态。
4. 产物未生成或未验证时不宣称交付成功。`,
  },
  {
    skillId: 'remote-sensing-raster-check',
    name: '遥感栅格检查',
    version: '1.0.0',
    description: '检查遥感与普通栅格的波段、分辨率、NoData、范围和统计特征。',
    aliases: ['遥感质检', '栅格审计', 'raster-check'],
    tags: ['gis', 'remote-sensing', 'raster'],
    capabilityRequirements: ['raster-metadata', 'read-only-analysis'],
    instructions: `# 遥感栅格检查

1. 读取波段数、数据类型、像元尺寸、CRS、范围、NoData 和时间元数据。
2. 检查波段语义、缩放因子、云/缺测掩膜和异常极值。
3. 多景或多时相比较前核对对齐、分辨率和采样策略。
4. 不从文件名推断未读取的传感器或波段信息。`,
  },
  {
    skillId: 'meteorological-data-check',
    name: '气象数据检查',
    version: '1.0.0',
    description: '核验气象变量、单位、时次、预报时效、维度与空间网格。',
    aliases: ['气象质检', '预报数据检查', 'meteo-check'],
    tags: ['meteorology', 'quality', 'temporal'],
    capabilityRequirements: ['meteorological-metadata', 'read-only-analysis'],
    instructions: `# 气象数据检查

1. 核对变量名、层次、单位、起报时间、预报时效、时区和时间顺序。
2. 检查维度、经纬度方向、网格分辨率、缺测值和物理范围。
3. 累积量、瞬时量和时段平均量必须区分，不混合不同时效。
4. 元数据冲突时保留证据并停止下游结论。`,
  },
  {
    skillId: 'analysis-report',
    name: '分析报告',
    version: '1.0.0',
    description: '基于工具账本、工作流和 Artifact 证据交付可追溯的地理分析报告。',
    aliases: ['GIS 报告', '空间分析报告', 'reporting'],
    tags: ['gis', 'report', 'delivery'],
    capabilityRequirements: ['workflow-evidence', 'artifact-delivery'],
    instructions: `# 分析报告

1. 报告必须区分用户目标、数据与方法、可验证结果、限制和交付物。
2. 关键数值和结论只引用工具账本、valueRef、Workflow 状态与 Artifact 证据。
3. 明确 CRS、空间/时间范围、数据来源和验证方法。
4. 阻断、缺失或未验证内容以限制呈现，不用补写结论掩盖。`,
  },
]

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'for', 'from', 'of', 'the', 'to', 'with',
  '一个', '一份', '请', '帮我', '进行', '完成',
])

export function buildSkillRegistry(
  config: RuntimeSkillConfig,
  baseDir: string,
  options: { strict?: boolean } = {},
): SkillRegistry {
  const strict = options.strict ?? true
  const diagnostics: SkillCatalogDiagnostic[] = []
  const rawSkills = BUILTIN_SKILLS.map(buildBuiltinSkill)

  const capture = (sourceLabel: string, operation: () => RawSkill | RawSkill[]): void => {
    try {
      const result = operation()
      rawSkills.push(...(Array.isArray(result) ? result : [result]))
    } catch (error) {
      const message = errorMessage(error)
      if (strict) throw error
      diagnostics.push({ code: 'skill_discovery_error', message, sourceLabel, skillId: null })
    }
  }

  for (const configuredRoot of config.skillRoots) {
    capture(configuredRoot, () => readSkillRoot(configuredRoot, baseDir))
  }
  for (const configuredPath of config.skillPaths) {
    capture(configuredPath, () => readSkillDirectory(
      resolveConfiguredHostPath(configuredPath, baseDir),
      { kind: 'direct', label: configuredPath },
    ))
  }

  const deduped = dedupeRawSkills(rawSkills, strict, diagnostics)
  const registrations = new Map(config.registrations.map(registration => [registration.skillId, registration]))
  const skills = deduped.map((skill): RegisteredSkill => {
    const registration = registrations.get(skill.skillId)
    const builtin = skill.source.kind === 'builtin'
    const enabled = registration?.enabled ?? true
    const trustStatus: SkillCatalogEntry['trustStatus'] = builtin
      ? 'builtin'
      : !registration?.trustedDigest
        ? 'untrusted'
        : registration.trustedDigest === skill.contentDigest
          ? 'trusted'
          : 'content_changed'
    const diagnostic = trustStatus === 'untrusted'
      ? '外部 Skill 尚未固定内容摘要，不会被运行时加载。'
      : trustStatus === 'content_changed'
        ? 'SKILL.md 或其资源内容已变化，需重新审查并信任新摘要。'
        : null
    if (diagnostic) {
      diagnostics.push({
        code: trustStatus === 'content_changed' ? 'skill_digest_changed' : 'skill_untrusted',
        message: `${skill.name}：${diagnostic}`,
        sourceLabel: skill.source.label,
        skillId: skill.skillId,
      })
    }
    registrations.delete(skill.skillId)
    return {
      catalog: {
        skillId: skill.skillId,
        name: skill.name,
        version: skill.version,
        description: skill.description,
        aliases: skill.aliases,
        tags: skill.tags,
        capabilityRequirements: skill.capabilityRequirements,
        source: skill.source,
        contentDigest: skill.contentDigest,
        enabled,
        trustStatus,
        active: config.enabled && enabled && (trustStatus === 'builtin' || trustStatus === 'trusted'),
        diagnostic,
      },
      manifestKey: skill.manifestKey,
      markdown: skill.markdown,
      absolutePath: skill.absolutePath,
    }
  })

  for (const skillId of registrations.keys()) {
    diagnostics.push({
      code: 'skill_registration_orphaned',
      message: `Skill 注册项 '${skillId}' 没有对应的内置或已配置目录。`,
      sourceLabel: null,
      skillId,
    })
  }

  skills.sort((left, right) => left.catalog.name.localeCompare(right.catalog.name, 'zh-CN'))
  return {
    skills,
    snapshot: {
      globalEnabled: config.enabled,
      autoMatchThreshold: config.autoMatchThreshold,
      candidateThreshold: config.candidateThreshold,
      entries: skills.map(skill => skill.catalog),
      diagnostics,
    },
  }
}

export function searchSkillRegistry(query: string, registry: SkillRegistry): SkillMatchResult[] {
  const normalizedQuery = normalize(query)
  const explicitIds = explicitSkillIds(query)
  const results = new Map<string, SkillMatchResult>()

  for (const explicitId of explicitIds) {
    const skill = registry.skills.find(candidate => normalize(candidate.catalog.skillId) === normalize(explicitId))
    if (!skill) continue
    results.set(skill.catalog.skillId, toMatch(skill.catalog, 1, 'explicit', `用户显式指定 /${explicitId}。`, true))
  }

  for (const skill of registry.skills) {
    if (results.has(skill.catalog.skillId)) continue
    const exactValue = [skill.catalog.skillId, skill.catalog.name, ...skill.catalog.aliases]
      .find(value => explicitlyMentions(normalizedQuery, value))
    if (!exactValue) continue
    results.set(skill.catalog.skillId, toMatch(
      skill.catalog,
      1,
      'exact',
      `查询精确命中名称或别名“${exactValue}”。`,
      true,
    ))
  }

  const queryTokens = [...new Set(tokenize(query))]
  const remaining = registry.skills.filter(skill => !results.has(skill.catalog.skillId))
  const documents = remaining.map(skill => tokenize([
    skill.catalog.skillId,
    skill.catalog.name,
    ...skill.catalog.aliases,
    ...skill.catalog.tags,
    skill.catalog.description,
  ].join(' ')))
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1
  const rawScores = documents.map(document => bm25Score(queryTokens, document, documents, averageLength))
  const maximum = Math.max(...rawScores, 0)
  const ranked = remaining
    .map((skill, index) => {
      const document = documents[index] ?? []
      const matchedTokens = queryTokens.filter(token => document.includes(token))
      const coverage = matchedTokens.length / (queryTokens.length || 1)
      const normalizedScore = maximum > 0 ? (rawScores[index] ?? 0) / maximum : 0
      return {
        skill,
        score: Number((normalizedScore * 0.78 + coverage * 0.22).toFixed(4)),
        matchedTokens,
      }
    })
    .filter(item => item.score >= registry.snapshot.candidateThreshold)
    .sort((left, right) => right.score - left.score || left.skill.catalog.skillId.localeCompare(right.skill.catalog.skillId))

  const topRelevance = ranked[0]
  const secondScore = ranked[1]?.score ?? 0
  for (const item of ranked) {
    const uniquelyHighConfidence = item === topRelevance
      && item.score >= registry.snapshot.autoMatchThreshold
      && (ranked.length === 1 || item.score - secondScore >= 0.08)
    results.set(item.skill.catalog.skillId, toMatch(
      item.skill.catalog,
      item.score,
      'relevance',
      item.matchedTokens.length
        ? `描述命中词项：${item.matchedTokens.join('、')}。`
        : '描述存在低置信相关性。',
      uniquelyHighConfidence,
    ))
  }

  return [...results.values()]
    .sort((left, right) => right.score - left.score || matchPriority(left.matchKind) - matchPriority(right.matchKind) || left.skillId.localeCompare(right.skillId))
}

export function selectRuntimeSkills(query: string, registry: SkillRegistry): {
  selected: RegisteredSkill[]
  matches: SkillMatchResult[]
} {
  const explicitIds = explicitSkillIds(query)
  for (const explicitId of explicitIds) {
    const skill = registry.skills.find(candidate => normalize(candidate.catalog.skillId) === normalize(explicitId))
    if (!skill) throw new Error(`显式指定的 Skill '${explicitId}' 不存在。`)
    if (!skill.catalog.enabled) throw new Error(`显式指定的 Skill '${explicitId}' 已禁用。`)
    if (skill.catalog.trustStatus === 'untrusted') {
      throw new Error(`显式指定的 Skill '${explicitId}' 尚未信任。`)
    }
    if (skill.catalog.trustStatus === 'content_changed') {
      throw new Error(`显式指定的 Skill '${explicitId}' 内容摘要已变化，需重新信任。`)
    }
  }

  const matches = searchSkillRegistry(query, registry)
  const selectedIds = new Set(matches.filter(match => match.autoLoad).map(match => match.skillId))
  return {
    selected: registry.skills.filter(skill => selectedIds.has(skill.catalog.skillId) && skill.catalog.active),
    matches,
  }
}

export function buildSkillSandboxEntry(skill: RegisteredSkill): Entry {
  const children: Record<string, Entry> = {
    'SKILL.md': file({ content: skill.markdown }),
  }
  if (skill.absolutePath) {
    for (const childName of ['scripts', 'references', 'assets']) {
      const childPath = path.join(skill.absolutePath, childName)
      if (!pathExists(childPath)) continue
      if (!isDirectory(childPath)) throw new Error(`Skill 的 ${childName}/ 必须是目录：${childPath}`)
      assertNoSymlinkAncestor(childPath)
      children[childName] = readSkillAssetDirectory(childPath)
    }
  }
  return dir({ children })
}

function buildBuiltinSkill(definition: BuiltinSkillDefinition): RawSkill {
  const markdown = [
    '---',
    `id: ${definition.skillId}`,
    `name: ${definition.name}`,
    `version: ${definition.version}`,
    `description: ${definition.description}`,
    `aliases: [${definition.aliases.join(', ')}]`,
    `tags: [${definition.tags.join(', ')}]`,
    `capabilities: [${definition.capabilityRequirements.join(', ')}]`,
    '---',
    '',
    definition.instructions,
  ].join('\n')
  return {
    ...definition,
    source: { kind: 'builtin', label: `平台内置 / ${definition.skillId}` },
    contentDigest: digestFiles([{ relativePath: 'SKILL.md', content: Buffer.from(markdown) }]),
    manifestKey: `builtin-${definition.skillId}`,
    markdown,
    absolutePath: null,
  }
}

function readSkillRoot(configuredRoot: string, baseDir: string): RawSkill[] {
  const absoluteRoot = resolveConfiguredHostPath(configuredRoot, baseDir)
  if (!pathExists(absoluteRoot)) throw new Error(`Skill 根目录不存在：${configuredRoot}`)
  assertNoSymlinkAncestor(absoluteRoot)
  if (!isDirectory(absoluteRoot)) throw new Error(`Skill 根路径不是目录：${configuredRoot}`)
  const rootEntries = readdirSync(absoluteRoot, { withFileTypes: true })
  const symlink = rootEntries.find(entry => entry.isSymbolicLink())
  if (symlink) throw new Error(`Skill 根目录不能包含符号链接：${configuredRoot}/${symlink.name}`)
  const children = rootEntries
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  if (children.length === 0) throw new Error(`Skill 根目录中没有可扫描的子目录：${configuredRoot}`)
  return children.map(child => readSkillDirectory(
    path.join(absoluteRoot, child.name),
    { kind: 'root', label: `${configuredRoot}/${child.name}` },
  ))
}

function readSkillDirectory(absolutePath: string, source: SkillSource): RawSkill {
  if (!pathExists(absolutePath)) throw new Error(`Skill 路径不存在：${source.label}`)
  assertNoSymlinkAncestor(absolutePath)
  if (!isDirectory(absolutePath)) throw new Error(`Skill 路径不是目录：${source.label}`)
  const skillFileNames = readdirSync(absolutePath).filter(entry => entry.toLowerCase() === 'skill.md')
  if (skillFileNames.length !== 1) throw new Error(`Skill 目录必须包含且只能包含一个 SKILL.md：${source.label}`)
  if (skillFileNames[0] !== 'SKILL.md') throw new Error(`Skill 文件名大小写必须严格为 SKILL.md：${source.label}`)
  const markdownPath = path.join(absolutePath, 'SKILL.md')
  if (lstatSync(markdownPath).isSymbolicLink()) throw new Error(`Skill 的 SKILL.md 不能是符号链接：${source.label}`)
  if (!lstatSync(markdownPath).isFile()) throw new Error(`Skill 目录中的 SKILL.md 必须是普通文件：${source.label}`)
  const markdown = readFileSync(markdownPath, 'utf8')
  const frontmatter = parseSkillFrontmatter(markdown)
  const directoryName = path.basename(absolutePath)
  const skillId = frontmatter.id?.trim() || frontmatter.name?.trim() || directoryName
  const name = frontmatter.name?.trim() || skillId
  return {
    skillId,
    name,
    version: frontmatter.version?.trim() || '0.0.0',
    description: frontmatter.description?.trim() || '未提供技能说明。',
    aliases: parseList(frontmatter.aliases),
    tags: parseList(frontmatter.tags),
    capabilityRequirements: parseList(frontmatter.capabilities),
    source,
    contentDigest: hashSkillDirectory(absolutePath, markdown),
    manifestKey: normalizeSkillManifestKey(directoryName),
    markdown,
    absolutePath,
  }
}

function hashSkillDirectory(absolutePath: string, markdown: string): string {
  const files: Array<{ relativePath: string; content: Buffer }> = [
    { relativePath: 'SKILL.md', content: Buffer.from(markdown) },
  ]
  for (const childName of ['scripts', 'references', 'assets']) {
    const childPath = path.join(absolutePath, childName)
    if (!pathExists(childPath)) continue
    if (!isDirectory(childPath)) throw new Error(`Skill 的 ${childName}/ 必须是目录：${childPath}`)
    collectSkillFiles(childPath, childName, files)
  }
  return digestFiles(files)
}

function collectSkillFiles(
  absolutePath: string,
  relativePath: string,
  files: Array<{ relativePath: string; content: Buffer }>,
): void {
  for (const entry of readdirSync(absolutePath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const childPath = path.join(absolutePath, entry.name)
    const childRelativePath = `${relativePath}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error(`Skill 资源目录不能包含符号链接：${childPath}`)
    if (entry.isDirectory()) {
      collectSkillFiles(childPath, childRelativePath, files)
      continue
    }
    if (entry.isFile()) {
      files.push({ relativePath: childRelativePath, content: readFileSync(childPath) })
      continue
    }
    throw new Error(`Skill 资源目录只能包含普通文件和目录：${childPath}`)
  }
}

function digestFiles(files: Array<{ relativePath: string; content: Buffer }>): string {
  const hash = createHash('sha256')
  for (const item of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(item.relativePath)
    hash.update('\0')
    hash.update(item.content)
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

function readSkillAssetDirectory(absolutePath: string): Entry {
  const children: Record<string, Entry> = {}
  for (const entry of readdirSync(absolutePath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const childPath = path.join(absolutePath, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Skill 资源目录不能包含符号链接：${childPath}`)
    if (entry.isDirectory()) {
      children[entry.name] = readSkillAssetDirectory(childPath)
      continue
    }
    if (entry.isFile()) {
      children[entry.name] = file({ content: readFileSync(childPath) })
      continue
    }
    throw new Error(`Skill 资源目录只能包含普通文件和目录：${childPath}`)
  }
  return dir({ children })
}

function dedupeRawSkills(
  skills: RawSkill[],
  strict: boolean,
  diagnostics: SkillCatalogDiagnostic[],
): RawSkill[] {
  const ids = new Map<string, RawSkill>()
  const names = new Map<string, RawSkill>()
  const manifestKeys = new Map<string, RawSkill>()
  const result: RawSkill[] = []
  for (const skill of skills) {
    const idKey = normalize(skill.skillId)
    const nameKey = normalize(skill.name)
    const manifestKey = normalize(skill.manifestKey)
    const conflicting = ids.get(idKey) ?? names.get(nameKey) ?? manifestKeys.get(manifestKey)
    if (conflicting) {
      const message = `Skill 冲突：'${skill.name}'（${skill.source.label}）与 '${conflicting.name}'（${conflicting.source.label}）使用了相同名称、ID 或目录键。`
      if (strict) throw new Error(message)
      diagnostics.push({ code: 'skill_name_conflict', message, sourceLabel: skill.source.label, skillId: skill.skillId })
      continue
    }
    ids.set(idKey, skill)
    names.set(nameKey, skill)
    manifestKeys.set(manifestKey, skill)
    result.push(skill)
  }
  return result
}

function parseSkillFrontmatter(markdown: string): Record<string, string> {
  const lines = markdown.split(/\r?\n/u)
  if (lines[0]?.trim() !== '---') return {}
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (endIndex < 0) return {}
  const result: Record<string, string> = {}
  for (const line of lines.slice(1, endIndex)) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key) result[key] = stripQuotes(value)
  }
  return result
}

function parseList(value: string | undefined): string[] {
  if (!value?.trim()) return []
  const normalized = value.trim().replace(/^\[/u, '').replace(/\]$/u, '')
  return [...new Set(normalized.split(',').map(item => stripQuotes(item.trim())).filter(Boolean))]
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1)
  }
  return value
}

function resolveConfiguredHostPath(input: string, baseDir: string): string {
  if (input.includes('\0')) throw new Error('路径不能包含空字节。')
  const resolvedBase = path.resolve(baseDir)
  const resolved = path.isAbsolute(input) ? path.resolve(input) : path.resolve(resolvedBase, input)
  if (!path.isAbsolute(input) && !isPathWithinRoot(resolvedBase, resolved)) {
    throw new Error(`相对路径不能逃逸项目根目录：${input}`)
  }
  return resolved
}

function normalizeSkillManifestKey(value: string): string {
  const normalized = value.trim()
  if (!/^[a-zA-Z0-9._-]+$/u.test(normalized)) {
    throw new Error(`Skill 目录名 '${value}' 只能包含字母、数字、点、下划线和连字符。`)
  }
  return normalized
}

function isDirectory(value: string): boolean {
  try {
    return lstatSync(value).isDirectory()
  } catch {
    return false
  }
}

function pathExists(value: string): boolean {
  try {
    lstatSync(value)
    return true
  } catch {
    return false
  }
}

function assertNoSymlinkAncestor(value: string): void {
  let current = path.resolve(value)
  while (true) {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Skill 路径不能包含符号链接：${value}`)
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function explicitSkillIds(query: string): string[] {
  return [...query.matchAll(/(?:^|\r?\n)\s*\/([a-zA-Z0-9._-]+)(?=\s|$)/gu)]
    .flatMap(match => match[1] ? [match[1]] : [])
}

function explicitlyMentions(query: string, value: string): boolean {
  const normalizedQuery = normalize(query)
  const normalizedValue = normalize(value)
  if (!normalizedValue) return false
  if (normalizedQuery === normalizedValue) return true
  if (/\p{Script=Han}/u.test(normalizedValue)) return normalizedQuery.includes(normalizedValue)
  const escaped = normalizedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(normalizedQuery)
}

function tokenize(value: string): string[] {
  return normalize(value)
    .replace(/([\p{Script=Han}]+)/gu, ' $1 ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length > 0 && !STOP_WORDS.has(token))
    .flatMap(token => {
      if (!/^\p{Script=Han}+$/u.test(token)) {
        return token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? [token.slice(0, -1)] : [token]
      }
      const chars = [...token]
      if (chars.length === 1) return chars
      return chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`)
    })
}

function bm25Score(queryTokens: string[], document: string[], documents: string[][], averageLength: number): number {
  return queryTokens.reduce((score, token) => {
    const frequency = document.filter(word => word === token).length
    if (frequency === 0) return score
    const documentFrequency = documents.filter(words => words.includes(token)).length
    const inverseDocumentFrequency = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5))
    const k1 = 1.2
    const lengthNormalization = 0.75
    return score + inverseDocumentFrequency * (
      frequency * (k1 + 1)
      / (frequency + k1 * (1 - lengthNormalization + lengthNormalization * (document.length / averageLength)))
    )
  }, 0)
}

function toMatch(
  skill: SkillCatalogEntry,
  score: number,
  matchKind: SkillMatchResult['matchKind'],
  reason: string,
  confidenceAllowsLoad: boolean,
): SkillMatchResult {
  return {
    skillId: skill.skillId,
    name: skill.name,
    score,
    matchKind,
    reason,
    autoLoad: confidenceAllowsLoad && skill.active,
    trustStatus: skill.trustStatus,
    enabled: skill.enabled,
  }
}

function matchPriority(kind: SkillMatchResult['matchKind']): number {
  if (kind === 'explicit') return 0
  if (kind === 'exact') return 1
  return 2
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().trim()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

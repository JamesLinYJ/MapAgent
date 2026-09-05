// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文件模式搜索实现
//
//   文件:       handler.ts
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { ToolHandler } from '../../../framework/types.js'
import { globFiles } from '../shared/glob.js'
import { resolveDeveloperPath } from '../shared/pathPolicy.js'
import { developerResult } from '../shared/result.js'
import { isDeveloperPathSensitive } from '../shared/secretPathPolicy.js'
import { assertDeveloperMode } from '../shared/modePolicy.js'

export const globFilesHandler: ToolHandler = async (args, context) => {
  if (typeof args.pattern !== 'string' || !args.pattern.trim()) throw new Error('pattern 不能为空')
  const roots = assertDeveloperMode(context)
  const root = await resolveDeveloperPath(args.path ?? '.', { mustExist: true, expectDirectory: true, roots })
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(Math.floor(args.limit), 1000)) : 100
  const result = await globFiles(root.absolutePath, args.pattern, limit, {
    allowPath: candidate => !isDeveloperPathSensitive(candidate),
  })
  const summary = result.matches.length ? `找到 ${result.matches.length} 个文件` : '未找到匹配文件'
  const partialNotice = result.partial
    ? `；${result.issueCount} 个目录无法完整读取，结果可能不完整`
    : ''
  return developerResult('glob_files', `${summary}${partialNotice}`, {
    root: root.absolutePath,
    relativeRoot: root.relativePath,
    pattern: args.pattern,
    matches: result.matches,
    count: result.matches.length,
    truncated: result.truncated,
    partial: result.partial,
    issueCount: result.issueCount,
    issues: result.issues,
  }, {
    provenance: {
      access: 'read_only',
      root: root.root,
    },
  })
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面导出清单构建器
//
//   文件:       exportManifest.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import {
  desktopExportManifestSchema,
  type DesktopExportManifest,
  type DesktopExportRequest,
} from '../contracts/desktopIpc.js'

export async function buildDesktopExportManifest(
  request: DesktopExportRequest,
  staging: string,
  files: readonly string[],
): Promise<DesktopExportManifest> {
  const entries = await Promise.all(files.map(async file => {
    const relativePath = safeManifestRelativePath(staging, file)
    const details = await stat(file)
    if (!details.isFile()) {
      throw new Error(`导出清单只允许记录普通文件：${relativePath}`)
    }
    return {
      name: relativePath,
      sizeBytes: details.size,
      sha256: await hashFile(file),
    }
  }))
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  return desktopExportManifestSchema.parse({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    threadId: request.threadId,
    title: request.title,
    files: entries,
  })
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function safeManifestRelativePath(staging: string, filePath: string): string {
  const relativePath = path.relative(path.resolve(staging), path.resolve(filePath))
  if (
    !relativePath
    || path.isAbsolute(relativePath)
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error('导出清单拒绝记录暂存目录之外的文件。')
  }
  return relativePath.split(path.sep).join('/')
}

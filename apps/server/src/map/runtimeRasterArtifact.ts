// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行目录栅格 Artifact 解析
//
//   文件:       runtimeRasterArtifact.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import fs from 'node:fs/promises'
import path from 'node:path'

export interface ResolvedRasterArtifact {
  path: string
  fingerprint: string
}

/**
 * 数据库只保存运行目录相对引用。解析时同时校验词法路径和 realpath，
 * 防止绝对路径、父目录及符号链接逃逸。
 */
export class RuntimeRasterArtifactResolver {
  constructor(private readonly runtimeRoot: string) {}

  async resolve(relativePath: string): Promise<ResolvedRasterArtifact> {
    rejectUnsafeReference(relativePath)
    const root = await fs.realpath(path.resolve(this.runtimeRoot))
    const candidate = path.resolve(root, relativePath)
    if (!isWithin(root, candidate)) throw new Error('栅格 Artifact 路径越过运行目录边界。')

    let canonicalPath: string
    try {
      canonicalPath = await fs.realpath(candidate)
    } catch {
      throw new Error('栅格 Artifact 文件不存在。')
    }
    if (!isWithin(root, canonicalPath)) throw new Error('栅格 Artifact 符号链接越过运行目录边界。')

    const extension = path.extname(canonicalPath).toLowerCase()
    if (extension !== '.tif' && extension !== '.tiff') {
      throw new Error('本地栅格瓦片只接受 GeoTIFF/COG Artifact。')
    }
    const stat = await fs.stat(canonicalPath)
    if (!stat.isFile()) throw new Error('栅格 Artifact 不是普通文件。')
    return {
      path: canonicalPath,
      fingerprint: `${canonicalPath}\u0000${stat.size}\u0000${stat.mtimeMs}`,
    }
  }
}

function rejectUnsafeReference(value: string): void {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('栅格 Artifact 路径无效。')
  }
  const slashPath = value.replaceAll('\\', '/')
  if (
    path.isAbsolute(value)
    || slashPath.startsWith('/')
    || /^[A-Za-z]:\//u.test(slashPath)
    || slashPath === '..'
    || slashPath.startsWith('../')
    || slashPath.split('/').includes('..')
  ) {
    throw new Error('栅格 Artifact 必须是运行目录内的相对路径。')
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

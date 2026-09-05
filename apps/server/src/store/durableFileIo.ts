// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久文件 IO 原语
//
//   文件:       durableFileIo.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 模块职责
//
// 提供 runtime 内容对象、附件审计和诊断日志需要的原子写、durable JSONL、
// 目录扫描和 ID 校验。这些函数不持有结构化会话事实。

import { randomUUID } from 'node:crypto'
import {
mkdir,
open,
readFile,
readdir,
rename,
rm,
} from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { nowUtc } from '../utils/ids.js'

const ATOMIC_REPLACE_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const ATOMIC_REPLACE_MAX_ATTEMPTS = 6
const ATOMIC_REPLACE_BASE_DELAY_MS = 12

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export async function appendJsonLineDurable(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const handle = await open(filePath, 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function recordJsonLineCorruption(
  filePath: string,
  threadId: string,
  lineNumber: number,
  error: unknown,
): Promise<void> {
  await appendJsonLineDurable(path.join(path.dirname(filePath), 'corruption.jsonl'), {
    threadId,
    file: path.basename(filePath),
    lineNumber,
    reason: error instanceof Error ? error.message : String(error),
    detectedAt: nowUtc(),
  })
}

export async function atomicWriteText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(value, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameWithRetry(temporary, filePath)
    if (process.platform === 'win32') {
      const target = await open(filePath, 'r+')
      try {
        await target.sync()
      } finally {
        await target.close()
      }
    } else {
      const directory = await open(path.dirname(filePath), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 1; attempt <= ATOMIC_REPLACE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      if (!shouldRetryAtomicReplace(error) || attempt === ATOMIC_REPLACE_MAX_ATTEMPTS) throw error
      await delay(ATOMIC_REPLACE_BASE_DELAY_MS * attempt)
    }
  }
}

function shouldRetryAtomicReplace(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && ATOMIC_REPLACE_RETRY_CODES.has(code)
}

export async function readJson<T>(filePath: string, schema: { parse(value: unknown): T }): Promise<T | null> {
  const raw = await readRawJson(filePath)
  return raw === null ? null : schema.parse(raw)
}

export async function readRawJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function listDirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function listFileNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function listFilesRecursively(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const nested = await Promise.all(entries.map(entry => {
      const target = path.join(root, entry.name)
      return entry.isDirectory() ? listFilesRecursively(target) : Promise.resolve([target])
    }))
    return nested.flat()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function safeId(value: string, field: string): string {
  const trimmed = value.trim()
  if (!/^[A-Za-z0-9_-]+$/u.test(trimmed)) throw new Error(`${field} 不是合法标识符`)
  return trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

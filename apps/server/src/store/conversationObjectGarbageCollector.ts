// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话对象垃圾回收
//
//   文件:       conversationObjectGarbageCollector.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { listDirectories, listFileNames, listFilesRecursively } from './durableFileIo.js'

interface AttachmentRecord {
  attachmentId: string
  action: 'attached' | 'deleted'
  contentRef: { hash?: unknown } | null
}

// 会话对象 GC 根据所有 JSON/JSONL 引用和附件最新状态决定对象存活。
// ConversationPayloadStore 提供根目录；本类不接触 session/thread/run 生命周期。
export class ConversationObjectGarbageCollector {
  constructor(
    private readonly sessionsRoot: string,
    private readonly objectsRoot: string,
  ) {}

  async collect(databaseReferences: Iterable<string> = []): Promise<{ removed: number; retained: number }> {
    const referenced = new Set<string>()
    for (const hash of databaseReferences) {
      if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error(`数据库对象引用不是有效的 SHA256：${hash}`)
      referenced.add(hash)
    }
    const runtimeRoot = path.dirname(this.sessionsRoot)
    const files = [
      ...await listFilesRecursively(this.sessionsRoot),
      ...await listFilesRecursively(path.join(runtimeRoot, 'uploads')),
    ]
    for (const filePath of files) {
      if (path.basename(filePath) === 'attachments.jsonl') {
        await this.collectAttachmentReferences(filePath, referenced)
        continue
      }
      if (!/\.(?:json|jsonl)$/u.test(filePath)) continue
      const content = await readFile(filePath, 'utf8')
      for (const match of content.matchAll(/(?:"hash"\s*:\s*"|objects\/sha256\/[a-f0-9]{2}\/)([a-f0-9]{64})/giu)) {
        const hash = match[1]
        if (hash) referenced.add(hash.toLowerCase())
      }
    }

    let removed = 0
    let retained = 0
    for (const prefix of await listDirectories(this.objectsRoot)) {
      const prefixRoot = path.join(this.objectsRoot, prefix)
      for (const objectName of await listFileNames(prefixRoot)) {
        const objectHash = objectHashFromFileName(objectName)
        if (objectHash && referenced.has(objectHash)) retained += 1
        else {
          await rm(path.join(prefixRoot, objectName), { force: true })
          removed += 1
        }
      }
    }
    return { removed, retained }
  }

  private async collectAttachmentReferences(filePath: string, referenced: Set<string>): Promise<void> {
    const latest = new Map<string, AttachmentRecord>()
    for (const line of (await readFile(filePath, 'utf8')).split('\n')) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line) as AttachmentRecord
        if (value.attachmentId) latest.set(value.attachmentId, value)
      } catch {
        // 损坏由 thread 读取路径负责隔离，GC 只跳过不可确认记录。
      }
    }
    for (const record of latest.values()) {
      if (record.action === 'attached' && typeof record.contentRef?.hash === 'string') {
        referenced.add(record.contentRef.hash)
      }
    }
  }
}

function objectHashFromFileName(fileName: string): string | null {
  return /^([a-f0-9]{64})(?:\.[a-z0-9]{1,12})?$/iu.exec(fileName)?.[1]?.toLowerCase() ?? null
}

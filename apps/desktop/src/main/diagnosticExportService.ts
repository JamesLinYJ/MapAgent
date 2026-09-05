// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机诊断包导出服务
//
//   文件:       diagnosticExportService.ts
//
//   日期:       2026年08月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { finished } from 'node:stream/promises'

import { BrowserWindow, dialog } from 'electron'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'
import {
  operationsLogEntrySchema,
  operationsSnapshotSchema,
} from '@geo-agent-platform/shared-types/operations'

import {
  desktopDiagnosticExportResultSchema,
  type DesktopDiagnosticExportResult,
} from '../contracts/desktopIpc.js'
import type { DesktopDiagnosticBundle } from './supervisorGateway.js'
import { sanitizeDesktopLogValue } from './desktopLogSanitizer.js'

/** 只有这个原生用户动作可以把内存诊断流写入硬盘。 */
export class DesktopDiagnosticExportService {
  async create(
    window: BrowserWindow,
    bundle: DesktopDiagnosticBundle,
  ): Promise<DesktopDiagnosticExportResult> {
    const timestamp = bundle.capturedAt.replace(/[:.]/gu, '-')
    const choice = await dialog.showSaveDialog(window, {
      title: `导出 ${PRODUCT_CODENAME} 本机诊断包`,
      defaultPath: `${safeFileStem(PRODUCT_CODENAME)}-diagnostics-${timestamp}.jsonl`,
      filters: [{ name: '脱敏诊断包', extensions: ['jsonl'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (choice.canceled || !choice.filePath) {
      return desktopDiagnosticExportResultSchema.parse({
        canceled: true,
        displayName: null,
        entryCount: 0,
      })
    }
    const outputPath = withJsonlExtension(choice.filePath)
    await writeDiagnosticBundle(outputPath, bundle)
    return desktopDiagnosticExportResultSchema.parse({
      canceled: false,
      displayName: path.basename(outputPath),
      entryCount: bundle.entries.length,
    })
  }
}

export async function writeDiagnosticBundle(
  outputPath: string,
  bundle: DesktopDiagnosticBundle,
): Promise<void> {
  const output = createWriteStream(outputPath, { encoding: 'utf8', flags: 'w' })
  const snapshot = operationsSnapshotSchema.parse(sanitizeDesktopLogValue(bundle.snapshot))
  const entries = bundle.entries.map(entry => operationsLogEntrySchema.parse(
    sanitizeDesktopLogValue(entry),
  ))
  try {
    await writeJsonLine(output, {
      recordType: 'manifest',
      formatVersion: bundle.formatVersion,
      capturedAt: bundle.capturedAt,
      snapshot,
      entryCount: entries.length,
    })
    for (const entry of entries) {
      await writeJsonLine(output, { recordType: 'log', entry })
    }
    output.end()
    await finished(output)
  } catch (error) {
    output.destroy()
    await rm(outputPath, { force: true })
    throw error
  }
}

async function writeJsonLine(output: NodeJS.WritableStream, value: unknown): Promise<void> {
  if (output.write(`${JSON.stringify(value)}\n`)) return
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      output.removeListener('error', onError)
      resolve()
    }
    const onError = (error: Error): void => {
      output.removeListener('drain', onDrain)
      reject(error)
    }
    output.once('drain', onDrain)
    output.once('error', onError)
  })
}

function withJsonlExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase() === '.jsonl' ? filePath : `${filePath}.jsonl`
}

function safeFileStem(value: string): string {
  return Array.from(value, character => (
    character.charCodeAt(0) <= 0x1f || '<>:"/\\|?*'.includes(character) ? '-' : character
  )).join('').replace(/[.\s]+$/gu, '').slice(0, 80) || 'diagnostics'
}

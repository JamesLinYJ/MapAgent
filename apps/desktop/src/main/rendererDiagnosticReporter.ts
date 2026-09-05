// +-------------------------------------------------------------------------
//
//   地理智能平台 - Renderer 诊断日志边界
//
//   文件:       rendererDiagnosticReporter.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  desktopRendererDiagnosticSchema,
  type DesktopRendererDiagnostic,
} from '../contracts/desktopIpc.js'

export interface RendererDiagnosticLogger {
  warn(event: string, details?: Record<string, unknown>): void
  error(event: string, error?: unknown, details?: Record<string, unknown>): void
}

/**
 * Renderer 只能提交固定字段的展示层诊断；Main 再通过统一日志脱敏和轮转边界落盘。
 */
export function reportRendererDiagnostic(
  logger: RendererDiagnosticLogger,
  input: unknown,
): DesktopRendererDiagnostic {
  const diagnostic = desktopRendererDiagnosticSchema.parse(input)
  const details = {
    rendererScope: diagnostic.scope,
    rendererMessage: diagnostic.message,
    ...(diagnostic.detail === null ? {} : { rendererDetail: diagnostic.detail }),
  }
  if (diagnostic.level === 'error') {
    logger.error('renderer_diagnostic', undefined, details)
  } else {
    logger.warn('renderer_diagnostic', details)
  }
  return diagnostic
}

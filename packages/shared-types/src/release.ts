// +-------------------------------------------------------------------------
//
//   地理智能平台 - 发布与运行时能力握手协议
//
//   文件:       release.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

/** Desktop 与 API 之间的稳定协议代号。协议变更必须显式递增。 */
export const API_PROTOCOL_VERSION = 1 as const
export const DESKTOP_PROTOCOL_VERSION = 1 as const

const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)

/**
 * 运行时能力是发布物之间唯一的兼容事实。`null` 只表示当前服务没有配置
 * Worker，而不是“校验失败后继续运行”。
 */
export const runtimeCapabilitiesSchema = z.object({
  releaseId: z.string().min(1).max(200),
  apiProtocolVersion: z.number().int().positive(),
  minDesktopProtocol: z.number().int().positive(),
  maxDesktopProtocol: z.number().int().positive(),
  databaseSchemaVersion: z.number().int().nonnegative(),
  workerContractDigest: sha256DigestSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.minDesktopProtocol > value.maxDesktopProtocol) {
    context.addIssue({
      code: 'custom',
      path: ['minDesktopProtocol'],
      message: 'Desktop 协议兼容下限不能高于上限。',
    })
  }
})

export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>

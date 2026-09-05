// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面导出审计协议
//
//   文件:       desktop.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import { mapSceneSchema } from './map.js'

const desktopExportResourceIdSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u, '导出资源 ID 格式无效。')

const desktopExportFormatSchema = z.enum(['pdf', 'png', 'zip'])
const desktopExportFormatsSchema = z.array(desktopExportFormatSchema)
  .min(1)
  .max(3)
  .refine(values => new Set(values).size === values.length, '导出格式不得重复。')

export const desktopExportSourceRequestSchema = z.object({
  workspaceId: desktopExportResourceIdSchema,
  sessionId: desktopExportResourceIdSchema,
  threadId: desktopExportResourceIdSchema,
}).strict()

export const desktopExportSourceSchema = z.object({
  workspaceId: desktopExportResourceIdSchema,
  sessionId: desktopExportResourceIdSchema,
  threadId: desktopExportResourceIdSchema,
  title: z.string().trim().min(1).max(180),
  conversationMarkdown: z.string()
    .max(8 * 1024 * 1024)
    .refine(
      value => new TextEncoder().encode(value).byteLength <= 8 * 1024 * 1024,
      '导出对话正文不得超过 8 MiB。',
    ),
  mapScene: mapSceneSchema,
}).strict()

export const desktopExportAuditRequestSchema = z.object({
  workspaceId: desktopExportResourceIdSchema,
  sessionId: desktopExportResourceIdSchema,
  threadId: desktopExportResourceIdSchema,
  title: z.string().trim().min(1).max(180),
  formats: desktopExportFormatsSchema,
  artifactIds: z.array(desktopExportResourceIdSchema).max(200)
    .refine(values => new Set(values).size === values.length, 'Artifact ID 不得重复。'),
  files: z.array(z.object({
    kind: desktopExportFormatSchema,
    displayName: z.string().trim().min(1).max(255),
  }).strict()).min(1).max(3),
}).strict().superRefine((value, context) => {
  const fileKinds = value.files.map(file => file.kind)
  if (new Set(fileKinds).size !== fileKinds.length) {
    context.addIssue({
      code: 'custom',
      path: ['files'],
      message: '同一种导出文件只能记录一次。',
    })
  }
  if (
    value.formats.length !== fileKinds.length
    || value.formats.some(format => !fileKinds.includes(format))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['files'],
      message: '审计文件必须与实际导出格式完全一致。',
    })
  }
})

export const desktopExportAuditResultSchema = z.object({
  recorded: z.literal(true),
}).strict()

export type DesktopExportAuditRequest = z.infer<typeof desktopExportAuditRequestSchema>
export type DesktopExportAuditResult = z.infer<typeof desktopExportAuditResultSchema>
export type DesktopExportSourceRequest = z.infer<typeof desktopExportSourceRequestSchema>
export type DesktopExportSource = z.infer<typeof desktopExportSourceSchema>

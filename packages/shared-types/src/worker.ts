// +-------------------------------------------------------------------------
//
//   地理智能平台 - Node 与 Worker 协议
//
//   文件:       worker.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 Node 与科学计算 Worker 的目录协商协议。
import { z } from 'zod'

// Python Pydantic 模型生成目录；TypeScript 只校验目录 envelope 与协商元数据。

export const toolContractManifestSchema = z.object({
  providerId: z.string(),
  toolName: z.string(),
  version: z.string(),
  parametersSchema: z.record(z.string(), z.unknown()),
  resultSchema: z.record(z.string(), z.unknown()),
  valueRefInputs: z.array(z.string()).default([]),
  valueRefOutputs: z.array(z.string()).default([]),
  readOnly: z.boolean().default(true),
  destructive: z.boolean().default(false),
  timeoutSeconds: z.number().positive().default(300),
  displaySurfaces: z.array(z.enum(['map', 'mini_app', 'download'])).default([]),
})

export type ToolContractManifest = z.infer<typeof toolContractManifestSchema>

export const workerToolSpecSchema = z.object({
  toolName: z.string(),
  route: z.string(),
  contract: toolContractManifestSchema,
  schemaHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
})

export type WorkerToolSpec = z.infer<typeof workerToolSpecSchema>

export const workerToolCatalogSchema = z.object({
  tools: z.array(workerToolSpecSchema),
  count: z.number().int().nonnegative(),
})

export type WorkerToolCatalog = z.infer<typeof workerToolCatalogSchema>

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面 API 组合响应 Schema
//
//   文件:       responseSchemas.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

export const unknownRecordSchema = z.record(z.string(), z.unknown())

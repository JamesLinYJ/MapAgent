// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆 ToolProvider
//
//   文件:       index.ts
//
//   日期:       2026年06月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { ToolProvider } from '../../framework/types.js'
import { memoryManifest, memoryTools } from './definitions.js'

const provider: ToolProvider = {
  manifest: memoryManifest,
  tools: () => memoryTools,
}

export default provider

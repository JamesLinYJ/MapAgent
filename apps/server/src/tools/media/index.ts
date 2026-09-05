// +-------------------------------------------------------------------------
//
//   地理智能平台 - Azure Speech Provider
//
//   文件:       index.ts
//
//   日期:       2026年07月01日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import manifest from './manifest.json' with { type: 'json' }
import type { ToolProvider } from '../../framework/types.js'
import type { Env } from '../../framework/env.js'
import { AzureSpeechService } from '../../speech/azureSpeechService.js'
import { createTextToSpeechTool } from './mediaTools.js'

export function createMediaProvider(env: Env): ToolProvider {
  return {
    manifest,
    tools: () => [createTextToSpeechTool(env)],
    async onInstall(ctx) {
      const speech = new AzureSpeechService(env)
      speech.defaultVoice()
      ctx.log('info', 'Azure Speech 媒体工具已加载')
    },
  }
}

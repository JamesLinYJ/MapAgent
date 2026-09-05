// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图 WebSocket 命令
//
//   文件:       mapCommands.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { WsCommandRegistry } from './commandRegistry.js'

export function registerMapCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'map-scene:update',
    handler: (payload, context) => context.dependencies.mapStore.updateScene(payload),
  })
}

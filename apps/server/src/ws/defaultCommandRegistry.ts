// +-------------------------------------------------------------------------
//
//   地理智能平台 - 默认 WS 命令注册表
//
//   文件:       defaultCommandRegistry.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { WsCommandRegistry } from './commandRegistry.js'
import { registerControlCommands } from './controlCommands.js'
import { registerCoreCommands } from './coreCommands.js'
import { registerMemoryCommands } from './memoryCommand.js'
import { registerMapCommands } from './mapCommands.js'
import { registerRunCommands } from './runCommands.js'
import { registerWsAuthorizationPolicies } from './security.js'
import { registerThreadCommands } from './threadCommands.js'
import { registerThreadContextCommands } from './threadContextCommands.js'
import { registerToolCommands } from './toolCommand.js'
import { registerUsageCommands } from './usageCommands.js'
import { registerAutomationCommands } from './automationCommands.js'
import { registerSubAgentCommands } from './subAgentCommands.js'
import { registerCustomProviderCommands } from './customProviderCommands.js'
import { registerWorkspaceCommands } from './workspaceCommands.js'
import { registerWsMutationResources } from './mutationResources.js'

// 所有 WS 控制命令必须从这里注册。handler 只持有这个注册表，不再知道
// 任何具体业务命令，测试也能直接验证协议枚举与注册表完全一致。
export function createDefaultCommandRegistry(): WsCommandRegistry {
  const registry = new WsCommandRegistry()
  registerCoreCommands(registry)
  registerWorkspaceCommands(registry)
  registerThreadCommands(registry)
  registerThreadContextCommands(registry)
  registerControlCommands(registry)
  registerRunCommands(registry)
  registerSubAgentCommands(registry)
  registerCustomProviderCommands(registry)
  registerMemoryCommands(registry)
  registerMapCommands(registry)
  registerToolCommands(registry)
  registerUsageCommands(registry)
  registerAutomationCommands(registry)
  registerWsAuthorizationPolicies(registry)
  registerWsMutationResources(registry)
  const missingAuthorization = registry.commandsWithoutAuthorization()
  if (missingAuthorization.length) {
    throw new Error(`以下 WS 命令缺少授权策略：${missingAuthorization.join('、')}`)
  }
  const missingMutationResources = registry.writeCommandsWithoutMutationResources()
  if (missingMutationResources.length) {
    throw new Error(`以下 WS 写命令缺少变更资源键：${missingMutationResources.join('、')}`)
  }
  return registry
}

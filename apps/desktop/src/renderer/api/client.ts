// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面 Renderer API 公共门面
//
//   文件:       client.ts
//
//   日期:       2026年06月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 业务实现按资源所有权分散在独立模块；该文件仅维护稳定导入入口，避免页面
// 同时了解认证、会话、运行、文件、工具和 Automation 的传输细节。

export * from './authApi'
export * from './conversationApi'
export * from './memoryApi'
export * from './mapApi'
export * from './resourceApi'
export * from './runApi'
export * from './subAgentApi'
export * from './customProviderApi'
export * from './toolApi'
export * from './automationApi'

export {
  apiBaseUrl,
  formatApiErrorMessage,
  requestDesktopDownload,
  requestDesktopOpen,
} from './transport'

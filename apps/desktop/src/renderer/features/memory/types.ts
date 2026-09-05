// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆功能类型
//
//   文件:       types.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 记忆索引属于记忆功能域，不属于聊天时间线或 ConversationItem。
export interface MemoryEntry {
  scope: 'private' | 'team'
  relativePath: string
  name: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  age: string
}

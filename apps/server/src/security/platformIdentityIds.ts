// +-------------------------------------------------------------------------
//
//   地理智能平台 - 平台身份确定性标识
//
//   文件:       platformIdentityIds.ts
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'

/** Better Auth 用户投影到平台用户时使用的唯一确定性标识规则。 */
export function platformUserIdFor(authUserId: string): string {
  return `user_${createHash('sha256').update(authUserId).digest('hex').slice(0, 24)}`
}

/** 个人工作区使用规范化邮箱生成稳定标识，避免重复创建。 */
export function personalWorkspaceIdFor(email: string): string {
  return `workspace_${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 24)}`
}

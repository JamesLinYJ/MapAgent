// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 服务主体标识
//
//   文件:       localAgentPrincipal.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHmac } from 'node:crypto'

export const LOCAL_AGENT_EMAIL_DOMAIN = 'local-agent.geo-agent-platform.invalid'
export const LOCAL_AGENT_EMAIL = `agent@${LOCAL_AGENT_EMAIL_DOMAIN}`

export interface LocalAgentCredential {
  email: string
  password: string
  keyVersion: string
}

/**
 * Agent 身份与账户管理 Console 使用不同的 HMAC 域。固定邮箱让根密钥轮换
 * 只更新凭据，不遗留新的平台管理员投影。
 */
export function deriveLocalAgentCredential(rootSecret: string): LocalAgentCredential {
  if (Buffer.byteLength(rootSecret, 'utf8') < 32) throw new Error('本机根密钥长度不足。')
  return {
    email: LOCAL_AGENT_EMAIL,
    password: derive(rootSecret, 'credential'),
    keyVersion: derive(rootSecret, 'identity').slice(0, 24).toLowerCase(),
  }
}

export function isLocalAgentEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${LOCAL_AGENT_EMAIL_DOMAIN}`)
}

function derive(rootSecret: string, purpose: string): string {
  return createHmac('sha256', rootSecret)
    .update(`geo-agent-platform-local-agent:${purpose}:v1`)
    .digest('base64url')
}

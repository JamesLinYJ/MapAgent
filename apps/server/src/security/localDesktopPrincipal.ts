// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Desktop 服务主体标识
//
//   文件:       localDesktopPrincipal.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHmac } from 'node:crypto'

export const LOCAL_DESKTOP_EMAIL_DOMAIN = 'local-desktop.geo-agent-platform.invalid'
export const LOCAL_DESKTOP_EMAIL = `desktop@${LOCAL_DESKTOP_EMAIL_DOMAIN}`

export interface LocalDesktopCredential {
  email: string
  password: string
  keyVersion: string
}

/**
 * Desktop 服务主体只由本机根密钥派生，不复用人类账号、引导管理员或公开注册。
 * 固定身份让密钥轮换只更新凭据，并保持平台投影和审计主体连续。
 */
export function deriveLocalDesktopCredential(rootSecret: string): LocalDesktopCredential {
  if (Buffer.byteLength(rootSecret, 'utf8') < 32) throw new Error('本机根密钥长度不足。')
  return {
    email: LOCAL_DESKTOP_EMAIL,
    password: derive(rootSecret, 'credential'),
    keyVersion: derive(rootSecret, 'identity').slice(0, 24).toLowerCase(),
  }
}

export function isLocalDesktopEmail(email: string): boolean {
  return email.trim().toLowerCase() === LOCAL_DESKTOP_EMAIL
}

function derive(rootSecret: string, purpose: string): string {
  return createHmac('sha256', rootSecret)
    .update(`geo-agent-platform-local-desktop:${purpose}:v1`)
    .digest('base64url')
}

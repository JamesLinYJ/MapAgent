// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Console 服务主体标识
//
//   文件:       localConsolePrincipal.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHmac } from 'node:crypto'

export const LOCAL_CONSOLE_EMAIL_DOMAIN = 'console.geo-agent-platform.invalid'

export interface LocalConsoleCredential {
  email: string
  password: string
  keyVersion: string
}

/** 根密钥只在本机进程内派生凭据；派生结果不会进入环境变量、日志或平台投影。 */
export function deriveLocalConsoleCredential(rootSecret: string): LocalConsoleCredential {
  if (Buffer.byteLength(rootSecret, 'utf8') < 32) throw new Error('本机根密钥长度不足。')
  // Better Auth 会把 email 规范为小写；派生身份必须在首次创建前使用相同规范。
  const keyVersion = derive(rootSecret, 'identity').slice(0, 24).toLowerCase()
  return {
    email: `console-${keyVersion}@${LOCAL_CONSOLE_EMAIL_DOMAIN}`,
    password: derive(rootSecret, 'credential'),
    keyVersion,
  }
}

export function isLocalConsoleEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${LOCAL_CONSOLE_EMAIL_DOMAIN}`)
}

function derive(rootSecret: string, purpose: string): string {
  return createHmac('sha256', rootSecret)
    .update(`geo-agent-platform-local-console:${purpose}:v1`)
    .digest('base64url')
}

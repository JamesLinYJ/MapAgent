// +-------------------------------------------------------------------------
//
//   地理智能平台 - Better Auth 桌面认证客户端
//
//   文件:       authClient.ts
//
//   日期:       2026年07月02日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import {
  desktopAuthBootstrapResultSchema,
  desktopAuthProjectionSchema,
  type DesktopAuthBootstrapResult,
  type DesktopAuthProjection,
} from '../../contracts/desktopIpc'
import { normalizeApiErrorMessage } from './errors'

export async function bootstrapDesktopAuth(): Promise<DesktopAuthBootstrapResult> {
  return desktopAuthBootstrapResultSchema.parse(
    await callDesktopAuth('bootstrap', {}, '初始化桌面认证失败'),
  )
}

export async function signInWithEmail(email: string, password: string) {
  await callDesktopAuth('sign-in-email', { email, password }, '登录失败')
}

export async function signUpWithEmail(input: { name: string; email: string; password: string }) {
  await callDesktopAuth('sign-up-email', input, '注册失败')
}

export async function signOutWithBetterAuth() {
  await callDesktopAuth('sign-out', {}, '退出登录失败')
}

export async function getDesktopAuthProjection(): Promise<DesktopAuthProjection> {
  return desktopAuthProjectionSchema.parse(
    await callDesktopAuth('projection', {}, '读取桌面身份失败'),
  )
}

async function callDesktopAuth(
  command: 'bootstrap' | 'projection' | 'sign-in-email' | 'sign-up-email' | 'sign-out',
  payload: Record<string, unknown>,
  fallback: string,
): Promise<unknown> {
  const bridge = typeof window === 'undefined' ? undefined : window.platformDesktop
  if (!bridge) throw new Error('认证只允许通过平台桌面主进程执行。')
  const response = await bridge.auth.request({
    version: 1,
    requestId: crypto.randomUUID(),
    command,
    payload,
  })
  if (!response.ok) throw new Error(normalizeApiErrorMessage(response.error?.message, fallback))
  return response.data
}



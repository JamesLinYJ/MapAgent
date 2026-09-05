// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 权限策略
//
//   文件:       desktopPermissionPolicy.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Session } from 'electron'

import type { MicrophonePermissionGate } from './microphonePermissionGate.js'
import { isTrustedApplicationUrl } from './trustedApplicationLocation.js'

/**
 * permission check 始终只读且 fail-closed；真正的主框架单 audio 请求才会
 * 在 request handler 中消费一次授权。视频、混合媒体、子框架、未知窗口和
 * 非可信来源始终拒绝。
 */
export function installDesktopPermissionPolicy(
  electronSession: Session,
  microphone: MicrophonePermissionGate,
): void {
  /*
   * Electron 的多数 Web API 只有在 check 被拒绝时才进入 request handler。
   * check 因此始终 fail-closed；它不消费或授予任何能力，完整校验集中在下方。
   */
  electronSession.setPermissionCheckHandler(() => false)

  electronSession.setPermissionRequestHandler((
    webContents,
    permission,
    callback,
    details,
  ) => {
    const microphoneOnly = permission === 'media'
      && 'mediaTypes' in details
      && details.isMainFrame
      && details.mediaTypes?.length === 1
      && details.mediaTypes[0] === 'audio'
    const trusted = isTrustedApplicationUrl(webContents.getURL())
      && isTrustedApplicationUrl(details.requestingUrl)
      && (
        !('securityOrigin' in details)
        || details.securityOrigin === undefined
        || isTrustedApplicationUrl(details.securityOrigin)
      )
    callback(Boolean(
      microphoneOnly
      && trusted
      && microphone.consume(webContents.id),
    ))
  })
}

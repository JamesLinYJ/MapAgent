// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面运行时兼容性握手
//
//   文件:       runtimeCompatibility.ts
//
//   说明:
//   以稳定的 API 进程身份缓存成功握手。Supervisor 快照序号只表示读取次数，
//   不能作为 API 实例身份；只有 API 进程重启后才需要重新握手。
// --------------------------------------------------------------------------

import type { OperationsSnapshot } from '@geo-agent-platform/shared-types/operations'
import {
  API_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION,
} from '@geo-agent-platform/shared-types/release'

import { getRuntimeCapabilities } from '../api/runtimeApi'

export async function ensureRuntimeCompatibility(
  snapshot: Pick<OperationsSnapshot, 'services'>,
  handshakeIdentity: { current: string | null },
  loadCapabilities: typeof getRuntimeCapabilities = getRuntimeCapabilities,
): Promise<void> {
  const processIdentity = runtimeApiProcessIdentity(snapshot)
  if (handshakeIdentity.current === processIdentity) return
  const capabilities = await loadCapabilities()
  assertRuntimeCapabilities(capabilities)
  handshakeIdentity.current = processIdentity
}

function runtimeApiProcessIdentity(
  snapshot: Pick<OperationsSnapshot, 'services'>,
): string {
  const api = snapshot.services.find(service => service.serviceId === 'api')
  if (!api || api.pid === null || api.startedAt === null) {
    throw new Error('平台 API 已报告健康，但缺少可验证的进程身份。')
  }
  return `api:${api.pid}:${api.startedAt}:${api.restartCount}`
}

export function assertRuntimeCapabilities(capabilities: {
  apiProtocolVersion: number
  minDesktopProtocol: number
  maxDesktopProtocol: number
}): void {
  if (capabilities.apiProtocolVersion !== API_PROTOCOL_VERSION) {
    throw new Error(
      `运行时 API 协议不兼容：服务为 ${capabilities.apiProtocolVersion}，桌面需要 ${API_PROTOCOL_VERSION}。`,
    )
  }
  if (
    DESKTOP_PROTOCOL_VERSION < capabilities.minDesktopProtocol
    || DESKTOP_PROTOCOL_VERSION > capabilities.maxDesktopProtocol
  ) {
    throw new Error(
      `桌面协议不兼容：当前为 ${DESKTOP_PROTOCOL_VERSION}，服务要求 ${capabilities.minDesktopProtocol}–${capabilities.maxDesktopProtocol}。`,
    )
  }
}

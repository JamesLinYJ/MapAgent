// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面实时事件投影
//
//   文件:       client.ts
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-29):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 网络连接所有权迁入 Electron Main；Renderer 仅校验并投影实时事件。
// --------------------------------------------------------------------------

import {
  wsServerPushSchema,
  type WsRunPush,
} from '@geo-agent-platform/shared-types'

import { useConnectionStore } from '../app/stores/connectionStore'

type WsClientMessage =
  | WsRunPush
  | { type: 'connected'; id: null; payload: { data: null } }
  | { type: 'disconnected'; id: null; payload: { data: { reason: string } } }

type Listener = (message: WsClientMessage) => void

export class DesktopRealtimeProjection {
  private readonly listeners = new Set<Listener>()
  private authenticatedUserId: string | null = null

  acceptDesktopMessage(input: unknown): void {
    const parsed = wsServerPushSchema.safeParse(input)
    if (!parsed.success) {
      this.setDesktopConnectionState('disconnected', '主进程推送了不符合共享协议的实时事件。')
      return
    }
    // keepalive 只证明 Main 与服务端之间的连接仍活跃，不是业务事件。
    if (parsed.data.type === 'keepalive') return
    this.emit(parsed.data)
  }

  setDesktopConnectionState(state: 'connected' | 'disconnected', reason?: string): void {
    if (state === 'connected') {
      useConnectionStore.getState().setWsConnected()
      this.emit({ type: 'connected', id: null, payload: { data: null } })
      return
    }
    const message = reason ?? '桌面控制连接已断开。'
    useConnectionStore.getState().setWsDisconnected(message)
    this.emit({
      type: 'disconnected',
      id: null,
      payload: { data: { reason: message } },
    })
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setAuthContext(userId: string | null): void {
    const changed = this.authenticatedUserId !== userId
    this.authenticatedUserId = userId
    if (changed && !userId) this.setDesktopConnectionState('disconnected', '认证上下文已清除。')
  }

  private emit(message: WsClientMessage): void {
    for (const listener of this.listeners) listener(message)
  }
}

export const wsClient = new DesktopRealtimeProjection()

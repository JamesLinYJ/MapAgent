// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 控制面协议
//
//   文件:       protocol.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import {
  parseWsControlRequest,
  wsControlCommandSchema,
  wsControlRequestEnvelopeSchema,
  wsControlResponseEnvelopeSchema,
  wsServerPushSchema,
  type WsControlRequestEnvelope,
  type WsControlRequestUnion,
  type WsControlFailureCode,
  type WsControlResponse,
  type WsServerPush,
  type WsServerPushData,
  type WsServerPushType,
} from '@geo-agent-platform/shared-types'

export const clientMsgType = wsControlCommandSchema

export type ClientMsg = WsControlRequestUnion

export class ClientMessageValidationError extends Error {
  constructor(
    readonly requestId: string | null,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'ClientMessageValidationError'
  }
}

export function parseMessage(raw: string): ClientMsg {
  const envelope = parseMessageEnvelope(raw)
  try {
    return parseWsControlRequest(envelope)
  } catch (error) {
    // 信封已经可信时，payload 错误仍必须用原请求 id 相关回复。
    throw new ClientMessageValidationError(envelope.id, error)
  }
}

export function parseMessageEnvelope(raw: string): WsControlRequestEnvelope {
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch (error) {
    throw new ClientMessageValidationError(null, error)
  }
  const envelope = wsControlRequestEnvelopeSchema.safeParse(input)
  if (!envelope.success) throw new ClientMessageValidationError(null, envelope.error)
  return envelope.data
}

export function success(id: string, data: unknown): string {
  return format(wsControlResponseEnvelopeSchema.parse({
    type: 'response',
    id,
    payload: { ok: true, data },
  }))
}

export function failure(id: string | null, code: WsControlFailureCode, message: string): string {
  return format(wsControlResponseEnvelopeSchema.parse({
    type: 'response',
    id,
    payload: { ok: false, error: { code, message } },
  }))
}

export function push<K extends WsServerPushType>(
  type: K,
  data: WsServerPushData<K>,
): string {
  return format(wsServerPushSchema.parse({ type, id: null, payload: { data } }))
}

function format(message: WsControlResponse | WsServerPush): string {
  return JSON.stringify(message) + '\n'
}

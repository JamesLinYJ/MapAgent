// +-------------------------------------------------------------------------
//
//   地理智能平台 - 内容对象访问网关
//
//   文件:       contentObjectGateway.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ContentRef } from '../schemas/types.js'
import type { ConversationPayloadStore } from './conversationPayloadStore.js'

// 网关只向上层暴露内容寻址对象的读写和 flush，不泄露线程载荷生命周期。
export class ContentObjectGateway {
  constructor(private readonly payloadStore: ConversationPayloadStore) {}

  put(content: string | Uint8Array, mediaType = 'application/octet-stream'): Promise<ContentRef> {
    return this.payloadStore.putObject(content, mediaType)
  }

  read(reference: ContentRef): Promise<Uint8Array> {
    return this.payloadStore.readObject(reference)
  }

  flush(): Promise<void> {
    return this.payloadStore.flush()
  }
}

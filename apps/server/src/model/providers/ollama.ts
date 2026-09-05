// +-------------------------------------------------------------------------
//
//   地理智能平台 - Ollama 模型适配器
//
//   文件:       ollama.ts
//
//   日期:       2026年06月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// Ollama 模型适配器
import type { ModelAdapter } from '../registry.js'
import { abortSignalWithTimeout } from '../../utils/abort.js'

export interface OllamaOptions { baseUrl: string; defaultModel: string; displayName?: string }

export function createOllamaAdapter(opts: OllamaOptions): ModelAdapter {
  const baseUrl = opts.baseUrl.replace(/\/$/, '')
  return {
    provider: 'ollama',
    displayName: opts.displayName ?? 'Ollama',
    defaultModel: opts.defaultModel,
    agentToolSchemaMode: 'compatible',
    agentRuntimeCapabilities: {
      transport: 'none',
      structuredOutput: 'none', functionTools: false, deferredTools: false,
      toolNamespaces: false, localMcp: false,
      hostedTools: false, handoffs: false, multiToolResponse: false,
      providerParallelToolControl: false, remoteConversation: false, serverCompaction: false,
    },
    isConfigured: () => Boolean(baseUrl && opts.defaultModel),
    capabilities: () => ['chat'],
    async chat(prompt: string, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>> {
      const model = (kwargs?.model as string) ?? opts.defaultModel
      const messages = (kwargs?.messages as Array<{ role: string; content: string }>) ?? [{ role: 'user', content: prompt }]
      const temperature = (kwargs?.temperature as number) ?? 0.1

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages, options: { temperature } }),
        signal: abortSignalWithTimeout(kwargs?.signal, 60_000),
      })
      if (!res.ok) throw new Error(`Ollama API error: ${res.status}`)
      const payload = (await res.json()) as Record<string, unknown>
      const message = payload.message as Record<string, unknown> | undefined
      return { provider: 'ollama', content: message?.content ?? '', raw: payload, model }
    },
  }
}

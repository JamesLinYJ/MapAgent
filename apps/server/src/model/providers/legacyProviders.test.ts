import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicAdapter } from './anthropic.js'
import { createGeminiAdapter } from './gemini.js'
import { createOllamaAdapter } from './ollama.js'

describe('HTTP model adapter boundaries', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends Anthropic messages through the configured endpoint', async () => {
    const request = stubResponse({ content: [{ type: 'text', text: 'Anthropic OK' }] })
    const adapter = createAnthropicAdapter({
      baseUrl: 'https://anthropic.example/',
      apiKey: 'test-key',
      defaultModel: 'claude-test',
      version: '2023-06-01',
    })

    await expect(adapter.chat('请回复 OK')).resolves.toMatchObject({
      provider: 'anthropic',
      content: 'Anthropic OK',
      model: 'claude-test',
    })
    expect(request).toHaveBeenCalledWith(
      'https://anthropic.example/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'test-key',
          'anthropic-version': '2023-06-01',
        }),
      }),
    )
  })

  it('maps Gemini assistant output without exposing transport fallback', async () => {
    const request = stubResponse({
      candidates: [{ content: { parts: [{ text: 'Gemini OK' }] } }],
    })
    const adapter = createGeminiAdapter({
      baseUrl: 'https://gemini.example/',
      apiKey: 'test-key',
      defaultModel: 'gemini-test',
    })

    await expect(adapter.chat('请回复 OK')).resolves.toMatchObject({
      provider: 'gemini',
      content: 'Gemini OK',
      model: 'gemini-test',
    })
    expect(request).toHaveBeenCalledWith(
      'https://gemini.example/models/gemini-test:generateContent',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-goog-api-key': 'test-key' }),
      }),
    )
  })

  it('maps Ollama chat output and reports configuration from explicit values', async () => {
    const request = stubResponse({ message: { content: 'Ollama OK' } })
    const adapter = createOllamaAdapter({
      baseUrl: 'http://127.0.0.1:11434/',
      defaultModel: 'qwen-test',
    })

    expect(adapter.isConfigured()).toBe(true)
    await expect(adapter.chat('请回复 OK')).resolves.toMatchObject({
      provider: 'ollama',
      content: 'Ollama OK',
      model: 'qwen-test',
    })
    expect(request).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/chat',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})

function stubResponse(payload: Record<string, unknown>) {
  const request = vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', request)
  return request
}

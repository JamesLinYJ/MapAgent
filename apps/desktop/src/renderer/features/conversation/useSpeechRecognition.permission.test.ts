// +-------------------------------------------------------------------------
//
//   地理智能平台 - 语音识别麦克风授权顺序测试
//
//   文件:       useSpeechRecognition.permission.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { SpeechAuthorization } from '@geo-agent-platform/shared-types'
import { describe, expect, it, vi } from 'vitest'

import { requestSpeechRecognitionAuthorization } from './useSpeechRecognition.js'

describe('speech recognition microphone permission', () => {
  it('does not request a Speech token when the user rejects native microphone permission', async () => {
    const requestSpeechAuthorization = vi.fn(async () => authorization())

    await expect(requestSpeechRecognitionAuthorization({
      requestMicrophonePermission: async () => ({
        granted: false,
        message: '你已取消本次麦克风授权，语音识别未启动。',
      }),
      requestSpeechAuthorization,
    })).rejects.toThrow('你已取消本次麦克风授权')

    expect(requestSpeechAuthorization).not.toHaveBeenCalled()
  })

  it('requests the short-lived Speech token only after native microphone permission', async () => {
    const order: string[] = []

    await expect(requestSpeechRecognitionAuthorization({
      requestMicrophonePermission: async () => {
        order.push('microphone')
        return { granted: true, message: null }
      },
      requestSpeechAuthorization: async () => {
        order.push('speech-token')
        return authorization()
      },
    })).resolves.toEqual(authorization())

    expect(order).toEqual(['microphone', 'speech-token'])
  })
})

function authorization(): SpeechAuthorization {
  return {
    authorizationToken: 'short-lived-token',
    region: 'chinaeast2',
    endpoint: 'wss://example.invalid',
    expiresAt: '2026-07-29T12:00:00.000Z',
    defaultLanguage: 'zh-CN',
    supportedLanguages: [{ locale: 'zh-CN', label: '中文（普通话）' }],
  }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - SDK 扩展审批适配器测试
//
//   文件:       runtimeSdkApproval.test.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { tool, type RunContext } from '@openai/agents'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { AgentsExecutionContext } from './agentsToolBridge.js'
import { applySdkExtensionApprovalPolicy } from './runtimeSdkApproval.js'

describe('applySdkExtensionApprovalPolicy', () => {
  it('routes the exact SDK call through the central StepContext approval service', async () => {
    const requiresSdkExtensionApproval = vi.fn(async () => true)
    const context = { requiresSdkExtensionApproval } as unknown as AgentsExecutionContext
    const wrapped = applySdkExtensionApprovalPolicy(tool<AgentsExecutionContext>({
      name: 'exec_command',
      description: '执行沙箱命令',
      parameters: z.object({ cmd: z.string() }),
      execute: async () => 'ok',
    }))
    if (wrapped.type !== 'function') throw new Error('测试工具不是 function tool')

    await expect(wrapped.needsApproval(
      { context } as RunContext<unknown>,
      { cmd: 'pwd' },
      'call_shell_1',
    )).resolves.toBe(true)
    expect(requiresSdkExtensionApproval).toHaveBeenCalledWith(
      'exec_command',
      { cmd: 'pwd' },
      'call_shell_1',
    )
  })

  it('rejects missing call identity and non-object arguments before policy evaluation', async () => {
    const requiresSdkExtensionApproval = vi.fn(async () => false)
    const context = { requiresSdkExtensionApproval } as unknown as AgentsExecutionContext
    const wrapped = applySdkExtensionApprovalPolicy(tool<AgentsExecutionContext>({
      name: 'write_file',
      description: '写入沙箱文件',
      parameters: z.object({ path: z.string() }),
      execute: async () => 'ok',
    }))
    if (wrapped.type !== 'function') throw new Error('测试工具不是 function tool')

    await expect(wrapped.needsApproval(
      { context } as RunContext<unknown>,
      { path: 'output.txt' },
    )).rejects.toThrow('缺少 callId')
    await expect(wrapped.needsApproval(
      { context } as RunContext<unknown>,
      'output.txt',
      'call_file_1',
    )).rejects.toThrow('JSON object')
    expect(requiresSdkExtensionApproval).not.toHaveBeenCalled()
  })
})

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 测试沙箱客户端
//
//   文件:       agentsSandboxClient.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  Manifest,
  normalizeSandboxClientCreateArgs,
  type SandboxClient,
  type SandboxSessionLike,
  type SandboxSessionState,
} from '@openai/agents/sandbox'
import type { SandboxClientFactory } from '../src/agent/runtimeSandbox.js'

interface TestSandboxTelemetry {
  createCount: number
  resumeCount: number
  serializeCount: number
  execCommands: string[]
  cleanupOptions: Array<Record<string, unknown>>
}

export interface InstrumentedTestSandboxClient {
  client: SandboxClient
  telemetry: TestSandboxTelemetry
}

function createSession(
  state: SandboxSessionState,
  telemetry: TestSandboxTelemetry,
): SandboxSessionLike {
  return {
    state,
    createEditor: () => ({
      createFile: async () => { throw new Error('测试 sandbox 不允许写入文件') },
      updateFile: async () => { throw new Error('测试 sandbox 不允许修改文件') },
      deleteFile: async () => { throw new Error('测试 sandbox 不允许删除文件') },
    }),
    execCommand: async args => {
      telemetry.execCommands.push(args.cmd)
      return `sandbox:${args.cmd}`
    },
    supportsPty: () => false,
    stop: async options => {
      telemetry.cleanupOptions.push({ ...options })
    },
  }
}

function restoreState(value: Record<string, unknown>): SandboxSessionState {
  const manifestValue = value.manifest
  if (!manifestValue || typeof manifestValue !== 'object' || Array.isArray(manifestValue)) {
    throw new Error('测试 Sandbox RunState 缺少 manifest')
  }
  return {
    ...value,
    // 测试 manifest 不包含挂载或凭据；恢复时仍通过公开构造器重建 SDK 对象，
    // 避免测试依赖 @openai/agents-core 的 internal 导出。
    manifest: new Manifest(),
    workspaceReady: value.workspaceReady !== false,
  }
}

export function createInstrumentedTestSandboxClient(
  backendId: string,
): InstrumentedTestSandboxClient {
  const telemetry: TestSandboxTelemetry = {
    createCount: 0,
    resumeCount: 0,
    serializeCount: 0,
    execCommands: [],
    cleanupOptions: [],
  }
  const client: SandboxClient = {
    backendId,
    create: async args => {
      telemetry.createCount += 1
      const normalized = normalizeSandboxClientCreateArgs(args)
      return createSession({
        manifest: normalized.manifest,
        workspaceReady: true,
      }, telemetry)
    },
    serializeSessionState: async () => {
      telemetry.serializeCount += 1
      return { testSession: true }
    },
    deserializeSessionState: async value => restoreState(value),
    resume: async state => {
      telemetry.resumeCount += 1
      return createSession(state, telemetry)
    },
    canPersistOwnedSessionState: () => true,
    canReusePreservedOwnedSession: () => false,
  }
  return { client, telemetry }
}

export const testSandboxClientFactory: SandboxClientFactory = config => (
  createInstrumentedTestSandboxClient(config.backend).client
)

function testSandboxManifest(): Manifest {
  return new Manifest()
}

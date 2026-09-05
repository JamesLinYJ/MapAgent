// +-------------------------------------------------------------------------
//
//   地理智能平台 - SDK 运行时集成测试
//
//   文件:       runtimeSdkIntegrations.test.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RunContext, tool, type MCPServer } from '@openai/agents'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import { buildSandboxManifest } from './runtimeSandbox.js'
import {
  buildRuntimeSdkSandboxIntegration,
  createRuntimeSdkIntegration,
} from './runtimeSdkIntegrations.js'
import { agentRuntimeConfigSchema } from '@geo-agent-platform/shared-types/runtime'
import type { AgentsExecutionContext } from './agentsToolBridge.js'
import { ToolExecutionGate } from '../agent-runtime/tools/ToolExecutionGate.js'
import { buildSkillRegistry } from './skillRegistry.js'

describe('runtime SDK integrations', () => {
  it('keeps the default runtime SDK config schema-valid with native web search enabled', () => {
    const parsed = agentRuntimeConfigSchema.parse(defaultRuntimeConfig())

    expect(parsed.sdk.hostedTools.webSearch).toEqual({
      enabled: true,
      searchContextSize: 'medium',
    })
    expect(parsed.sdk.mcp.enabled).toBe(false)
    expect(parsed.sdk.mcp.servers).toHaveLength(0)
    expect(parsed.sdk.skills.enabled).toBe(false)
    expect(parsed.sdk.skills.skillPaths).toHaveLength(0)
    expect(parsed.sdk.skills.skillRoots).toHaveLength(0)
    expect(parsed.sdk.skills.registrations).toHaveLength(0)
  })

  it('rejects enabled HTTP MCP server config without a URL', () => {
    const config = defaultRuntimeConfig()
    config.sdk.mcp = {
      enabled: true,
      connectTimeoutMs: 1000,
      closeTimeoutMs: 1000,
      servers: [{
        enabled: true,
        name: 'docs',
        description: '文档 MCP',
        transport: 'streamable_http',
        executionMode: 'function_tools',
        url: null,
        command: null,
        args: [],
        cwd: null,
        env: {},
        headers: {},
        allowedTools: [],
        blockedTools: [],
        includeServerInToolNames: true,
        convertSchemasToStrict: true,
        cacheToolsList: true,
        useStructuredContent: true,
        approval: 'always',
        timeoutMs: 1000,
      }],
    }

    const parsed = agentRuntimeConfigSchema.safeParse(config)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.map(issue => issue.message).join('\n')).toContain('HTTP/SSE MCP 必须配置 url')
    }
  })

  it('routes only a trusted high-confidence built-in Skill into the run sandbox', () => {
    const config = defaultRuntimeConfig({ sandbox: { backend: 'unix_local' } })
    config.sdk.skills.enabled = true

    const matched = buildRuntimeSdkSandboxIntegration(config, { query: '请先做坐标系审计' })
    expect(matched.activeSkills).toEqual(['crs-audit'])
    expect(matched.skillMatches[0]).toMatchObject({
      skillId: 'crs-audit',
      matchKind: 'exact',
      autoLoad: true,
    })

    const unmatched = buildRuntimeSdkSandboxIntegration(config, { query: '问候你好' })
    expect(unmatched.activeSkills).toEqual([])
    expect(unmatched.capabilities).toEqual([])
  })

  it('never enables Skill instructions without a sandbox backend', () => {
    const config = defaultRuntimeConfig()
    config.sdk.skills.enabled = true

    expect(() => buildRuntimeSdkSandboxIntegration(config, { query: '/crs-audit' }))
      .toThrow('SDK Skill 依赖沙箱工作区')
  })

  it('reports an explicit Skill request when the global switch is disabled', () => {
    const config = defaultRuntimeConfig({ sandbox: { backend: 'unix_local' } })

    expect(() => buildRuntimeSdkSandboxIntegration(config, { query: '/crs-audit' }))
      .toThrow('Skill 总开关已关闭')
  })

  it('materializes configured SDK skills through the Sandbox skills capability', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-sdk-skills-')))
    try {
      const skillRoot = path.join(root, 'skills')
      const skillDir = path.join(skillRoot, 'geo-skill')
      await mkdir(skillDir, { recursive: true })
      await writeFile(path.join(skillDir, 'SKILL.md'), [
        '---',
        'name: geo-skill',
        'description: 读取地理数据 Skill。',
        '---',
        '',
        '# Geo Skill',
      ].join('\n'))

      const config = defaultRuntimeConfig({ sandbox: { backend: 'unix_local' } })
      config.sdk.skills = {
        enabled: true,
        skillsPath: '.agents',
        skillPaths: [],
        skillRoots: [skillRoot],
        registrations: [],
        autoMatchThreshold: 0.72,
        candidateThreshold: 0.12,
      }
      const discovered = buildSkillRegistry(config.sdk.skills, process.cwd()).skills
        .find(skill => skill.catalog.skillId === 'geo-skill')
      if (!discovered) throw new Error('geo-skill missing from registry')
      config.sdk.skills.registrations = [{
        skillId: 'geo-skill',
        enabled: true,
        trustedDigest: discovered.catalog.contentDigest,
      }]

      const integration = buildRuntimeSdkSandboxIntegration(config, { query: '/geo-skill' })
      expect(integration.activeSkills).toEqual(['geo-skill'])
      expect(integration.pathGrants).toHaveLength(0)

      const manifest = buildSandboxManifest({ runId: 'run_1', sessionId: 'session_1' }, 'thread_1', integration.pathGrants)
      const processed = integration.capabilities.reduce((current, capability) => capability.processManifest(current), manifest)
      const instructions = await integration.capabilities[0]?.instructions(processed)
      expect(instructions).toContain('geo-skill')
      expect(instructions).toContain('load_skill')
      expect(processed.extraPathGrants).toHaveLength(0)

      const capability = integration.capabilities[0]
      if (!capability) throw new Error('Skills capability missing')
      capability.bind({
        state: { manifest: processed },
        pathExists: async () => false,
        materializeEntry: async () => {},
      } as never)
      const [loadSkill] = capability.tools()
      if (!loadSkill || loadSkill.type !== 'function') throw new Error('load_skill tool missing')
      let extensionEnabled = true
      const runContext = new RunContext<AgentsExecutionContext>({
        runId: 'run_skill',
        isExecutionEnabled: () => true,
        isSdkExtensionEnabled: () => extensionEnabled,
        isToolEnabled: () => true,
        validateToolCall: () => null,
        formatToolFailureForModel: (_toolName, message) => message,
        rejectPreparedToolCall: async () => {},
        canonicalizeToolCall: async (_toolName, args) => args,
        prepareToolCall: async () => {},
        requiresApproval: async () => false,
        requiresSdkExtensionApproval: async () => false,
        executeTool: async () => 'ok',
        runToolExecution: async (_lane, operation) => operation(),
        toolOutputMetadata: callId => ({
          schemaVersion: 1,
          callId,
          toolName: 'load_skill',
          resultId: null,
          valueRefIds: [],
          artifactIds: [],
          display: null,
        }),
      })
      await expect(loadSkill.isEnabled(runContext, {} as never)).resolves.toBe(true)
      extensionEnabled = false
      await expect(loadSkill.isEnabled(runContext, {} as never)).resolves.toBe(true)
      await expect(loadSkill.invoke(runContext, '{"skill_name":"geo-skill"}')).resolves.toMatchObject({
        status: 'loaded',
        skill_name: 'geo-skill',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('mounts current-run artifacts read-only at the relative path returned by tools', () => {
    const artifactDirectory = path.join(process.cwd(), 'runtime', 'artifacts', 'run_1')
    const manifest = buildSandboxManifest(
      { runId: 'run_1', sessionId: 'session_1' },
      'thread_1',
      [],
      { artifactDirectory },
    )
    const artifactsEntry = manifest.entries.artifacts
    expect(artifactsEntry?.type).toBe('dir')
    if (!artifactsEntry || artifactsEntry.type !== 'dir') throw new Error('artifacts manifest entry missing')
    expect(artifactsEntry.children?.run_1).toMatchObject({
      type: 'mount',
      source: path.resolve(artifactDirectory),
      readOnly: true,
      mountStrategy: { type: 'local_bind' },
    })
  })

  it('rejects enabled SDK skills when no SKILL.md exists', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-sdk-skills-empty-')))
    try {
      const config = defaultRuntimeConfig({ sandbox: { backend: 'unix_local' } })
      config.sdk.skills = {
        enabled: true,
        skillsPath: '.agents',
        skillPaths: [],
        skillRoots: [root],
        registrations: [],
        autoMatchThreshold: 0.72,
        candidateThreshold: 0.12,
      }

      expect(() => buildRuntimeSdkSandboxIntegration(config)).toThrow('没有可扫描的子目录')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects SDK skills whose SKILL.md casing is not exact', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-sdk-skills-case-')))
    try {
      const skillDir = path.join(root, 'geo-skill')
      await mkdir(skillDir, { recursive: true })
      await writeFile(path.join(skillDir, 'sKilL.md'), '# Wrong case')

      const config = defaultRuntimeConfig({ sandbox: { backend: 'unix_local' } })
      config.sdk.skills = {
        enabled: true,
        skillsPath: '.agents',
        skillPaths: [skillDir],
        skillRoots: [],
        registrations: [],
        autoMatchThreshold: 0.72,
        candidateThreshold: 0.12,
      }

      expect(() => buildRuntimeSdkSandboxIntegration(config)).toThrow('大小写必须严格为 SKILL.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads MCP function tools and applies approval by default', async () => {
    const config = defaultRuntimeConfig()
    enableTestMcp(config, 'always')
    let closed = false
    const fakeServer = { name: 'docs' } as MCPServer
    const integration = await createRuntimeSdkIntegration(config, new Set(), new ToolExecutionGate(), {
      connectMcpServers: async () => ({
        active: [fakeServer],
        close: async () => { closed = true },
      }),
      getAllMcpTools: async () => [
        tool({
          name: 'docs_search',
          description: '搜索文档。',
          parameters: z.object({ query: z.string() }),
          execute: async () => 'ok',
        }),
      ],
    })

    expect(integration.activeMcpServers).toEqual(['docs'])
    expect(integration.tools.map(candidate => candidate.name)).toEqual(['docs_search'])
    expect([...integration.mcpToolNames]).toEqual(['docs_search'])
    expect([...integration.mcpToolServers]).toEqual([['docs_search', 'docs']])
    expect(integration.mcpBinding).toMatchObject({
      catalogRevision: 1,
      refreshReasons: ['initial'],
      servers: [{ name: 'docs', toolNames: ['docs_search'], resourceUris: [] }],
    })
    const [mcpTool] = integration.tools
    expect(mcpTool?.type).toBe('function')
    if (mcpTool?.type !== 'function') throw new Error('测试工具必须是 function tool')
    let executionEnabled = true
    let sdkExtensionEnabled = true
    const context = new RunContext<AgentsExecutionContext>({
      runId: 'run_1',
      isExecutionEnabled: () => executionEnabled,
      isSdkExtensionEnabled: () => sdkExtensionEnabled,
      isToolEnabled: () => true,
      validateToolCall: () => null,
      formatToolFailureForModel: (_toolName, message) => message,
      rejectPreparedToolCall: async () => {},
      canonicalizeToolCall: async (_toolName, args) => args,
      prepareToolCall: async () => {},
      requiresApproval: async () => false,
      requiresSdkExtensionApproval: async () => true,
      executeTool: async () => 'ok',
      runToolExecution: async (_lane, operation) => operation(),
      toolOutputMetadata: callId => ({
        schemaVersion: 1,
        callId,
        toolName: 'docs_search',
        resultId: null,
        valueRefIds: [],
        artifactIds: [],
        display: null,
      }),
    })
    await expect(mcpTool.needsApproval(context, { query: 'abc' }, 'call_1')).resolves.toBe(true)
    await expect(mcpTool.isEnabled(context, {} as never)).resolves.toBe(true)
    if (!mcpTool.customDataExtractor) throw new Error('MCP function tool 缺少 customDataExtractor')
    expect(mcpTool.customDataExtractor({
      runContext: context,
      tool: mcpTool,
      toolCall: {
        type: 'function_call',
        callId: 'call_1',
        name: 'docs_search',
        arguments: '{"query":"abc"}',
      },
      input: { query: 'abc' },
      output: 'ok',
      rawItem: {
        type: 'function_call_result',
        callId: 'call_1',
        name: 'docs_search',
        output: 'ok',
      },
    })).toEqual({
      schemaVersion: 1,
      callId: 'call_1',
      toolName: 'docs_search',
      resultId: null,
      valueRefIds: [],
      artifactIds: [],
      display: {
        label: 'docs_search',
        summary: null,
        source: 'mcp:docs',
      },
    })
    sdkExtensionEnabled = false
    await expect(mcpTool.isEnabled(context, {} as never)).resolves.toBe(false)
    await expect(mcpTool.invoke(context, '{"query":"abc"}')).rejects.toThrow('结构化工作流边界禁止调用 MCP 工具')
    await integration.close()
    expect(closed).toBe(true)
  })

  it('hard-fails an MCP tool collision and closes the rejected binding connection', async () => {
    const config = defaultRuntimeConfig()
    enableTestMcp(config, 'always')
    let closed = false

    await expect(createRuntimeSdkIntegration(
      config,
      new Set(['list_layers']),
      new ToolExecutionGate(),
      {
        connectMcpServers: async servers => ({
          active: servers,
          close: async () => { closed = true },
        }),
        getAllMcpTools: async () => [tool({
          name: 'list_layers',
          description: '冲突工具',
          parameters: z.object({}),
          execute: async () => 'unexpected',
        })],
      },
    )).rejects.toThrow(/MCP 工具名 'list_layers'.*重名/u)
    expect(closed).toBe(true)
  })

  it('exposes approval-free MCP only as a locally managed SDK function tool', async () => {
    const config = defaultRuntimeConfig()
    enableTestMcp(config, 'never')
    let connectedServer: MCPServer | null = null
    let closed = false
    const integration = await createRuntimeSdkIntegration(
      config,
      new Set(['platform_tool']),
      new ToolExecutionGate(),
      {
      connectMcpServers: async servers => {
        connectedServer = servers[0] ?? null
        return {
          active: servers,
          close: async () => { closed = true },
        }
      },
      getAllMcpTools: async options => {
        expect(options.mcpServers).toHaveLength(1)
        expect(options.includeServerInToolNames).toBe(true)
        expect(options.convertSchemasToStrict).toBe(true)
        expect(options.reservedToolNames).toEqual(new Set(['platform_tool']))
        return [tool({
          name: 'docs_search',
          description: '搜索文档。',
          parameters: z.object({ query: z.string() }),
          execute: async () => 'ok',
        })]
      },
      },
    )

    expect(integration.tools.map(candidate => candidate.name)).toEqual(['docs_search'])
    expect(connectedServer?.name).toBe('docs')
    expect([...integration.mcpToolNames]).toEqual(['docs_search'])

    const [mcpTool] = integration.tools
    if (mcpTool?.type !== 'function') throw new Error('MCP 必须作为本地 function tool 暴露')
    let sdkExtensionEnabled = true
    const runContext = new RunContext<AgentsExecutionContext>({
      runId: 'run_native_mcp',
      isExecutionEnabled: () => true,
      isSdkExtensionEnabled: () => sdkExtensionEnabled,
      isToolEnabled: () => true,
      validateToolCall: () => null,
      formatToolFailureForModel: (_toolName, message) => message,
      rejectPreparedToolCall: async () => {},
      canonicalizeToolCall: async (_toolName, args) => args,
      prepareToolCall: async () => {},
      requiresApproval: async () => false,
      requiresSdkExtensionApproval: async () => false,
      executeTool: async () => 'ok',
      runToolExecution: async (_lane, operation) => operation(),
      toolOutputMetadata: callId => ({
        schemaVersion: 1,
        callId,
        toolName: 'docs_search',
        resultId: null,
        valueRefIds: [],
        artifactIds: [],
        display: null,
      }),
    })
    await expect(mcpTool.needsApproval(runContext, { query: 'abc' }, 'call_1')).resolves.toBe(false)
    await expect(mcpTool.isEnabled(runContext, {} as never)).resolves.toBe(true)
    await expect(mcpTool.invoke(runContext, '{"query":"abc"}')).resolves.toBe('ok')
    sdkExtensionEnabled = false
    await expect(mcpTool.isEnabled(runContext, {} as never)).resolves.toBe(false)
    await expect(mcpTool.invoke(runContext, '{"query":"abc"}')).rejects.toThrow(
      '结构化工作流边界禁止调用 MCP 工具',
    )

    await integration.close()
    expect(closed).toBe(true)
  })
})

function enableTestMcp(
  config: ReturnType<typeof defaultRuntimeConfig>,
  approval: 'always' | 'never',
): void {
  config.sdk.mcp = {
    enabled: true,
    connectTimeoutMs: 1000,
    closeTimeoutMs: 1000,
    servers: [{
      enabled: true,
      name: 'docs',
      description: '文档 MCP',
      transport: 'streamable_http',
      executionMode: 'function_tools',
      url: 'http://127.0.0.1:9999/mcp',
      command: null,
      args: [],
      cwd: null,
      env: {},
      headers: {},
      allowedTools: [],
      blockedTools: [],
      includeServerInToolNames: true,
      convertSchemasToStrict: true,
      cacheToolsList: true,
      useStructuredContent: true,
      approval,
      timeoutMs: 1000,
    }],
  }
}

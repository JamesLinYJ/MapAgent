// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型与账号配置页测试
//
//   文件:       modelSettingsPage.test.tsx
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ModelProviderDescriptor } from '@geo-agent-platform/shared-types'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { ModelSettingsPage } from '../features/settings/ModelSettingsPage'
import { ProductIdentityProvider } from '../app/ProductIdentityProvider'

describe('ModelSettingsPage', () => {
  it('shows only catalog models and keeps account management optional', () => {
    const html = renderToStaticMarkup(
      <ProductIdentityProvider
        productName="团队地理工作台"
        onOpenSettings={vi.fn()}
        setupStatus={{
          state: 'configured',
          deploymentMode: 'local_managed',
          apiBaseUrl: 'http://127.0.0.1:8000',
          productName: '团队地理工作台',
          canReset: false,
          canConfigureMapService: true,
          tiandituConfigured: false,
        }}
      >
        <ModelSettingsPage
          authMode="local_auto"
          canAccessAccount={false}
          provider="deepseek"
          model="deepseek-v4-flash"
          providers={[deepSeek(), unavailableProvider()]}
          onProviderChange={vi.fn()}
          onModelChange={vi.fn()}
          onOpenAccount={vi.fn()}
        />
      </ProductIdentityProvider>,
    )

    expect(html).toContain('本机身份由应用托管')
    expect(html).toContain('服务与模型')
    expect(html).toContain('团队地理工作台')
    expect(html).toContain('修改名称与地图')
    expect(html).toContain('尚未配置天地图服务端密钥')
    expect(html).toContain('配置密钥')
    expect(html).toContain('deepseek-v4-flash')
    expect(html).toContain('128,000 词元')
    expect(html).not.toContain('deepseek-v4-pro')
    expect(html).toContain('DeepSeek 响应接口')
    expect(html).not.toContain('打开账号中心')
    expect(html).not.toContain('任意模型名称')
    expect(html).toContain('disabled=""')
  })

  it('does not present an unavailable provider default as an executable model route', () => {
    const html = renderToStaticMarkup(
      <ProductIdentityProvider productName="本机工作台" onOpenSettings={vi.fn()}>
        <ModelSettingsPage
          authMode="local_auto"
          canAccessAccount={false}
          provider="disabled"
          model="removed-model"
          providers={[unavailableProvider()]}
          onProviderChange={vi.fn()}
          onModelChange={vi.fn()}
          onOpenAccount={vi.fn()}
        />
      </ProductIdentityProvider>,
    )

    expect(html).toContain('尚未配置可执行模型')
    expect(html).toContain('尚未选择可用模型')
    expect(html).toContain('model-settings__summary is-unavailable')
    expect(html).toContain('未接入智能分析')
    expect(html).toContain('当前不可用')
    expect(html).not.toContain('removed-model')
    expect(html).not.toContain('辅助适配器')
  })

  it('shows the fixed terminal command entry on macOS without accepting a path', () => {
    vi.stubGlobal('window', { platformDesktop: { platform: 'darwin' } })
    try {
      const html = renderToStaticMarkup(
        <ProductIdentityProvider productName="本机工作台" onOpenSettings={vi.fn()}>
          <ModelSettingsPage
            authMode="local_auto"
            canAccessAccount={false}
            provider="deepseek"
            model="deepseek-v4-flash"
            providers={[deepSeek()]}
            onProviderChange={vi.fn()}
            onModelChange={vi.fn()}
            onOpenAccount={vi.fn()}
          />
        </ProductIdentityProvider>,
      )

      expect(html).toContain('05 · 终端命令')
      expect(html).toContain('在终端中使用智能体')
      expect(html).toContain('/usr/local/bin/geo-agent-platform')
      expect(html).toContain('06 · 身份')
      expect(html).not.toContain('命令安装路径')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

function deepSeek(): ModelProviderDescriptor {
  return {
    provider: 'deepseek',
    displayName: 'DeepSeek',
    configured: true,
    source: 'builtin',
    defaultModel: 'deepseek-v4-flash',
    availableModels: ['deepseek-v4-flash'],
    models: [{
      modelId: 'deepseek-v4-flash',
      contextWindowTokens: 128_000,
      capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
      modalities: ['text'],
    }],
    capabilities: ['agents_sdk_live_supervisor', 'responses', 'tool_calls'],
    modalities: ['text'],
    protocol: 'responses',
    contextWindowTokens: 128_000,
    agentRuntime: {
      transport: 'deepseek_responses',
      structuredOutput: 'json_schema',
      functionTools: true,
      deferredTools: false,
      toolNamespaces: false,
      localMcp: true,
      hostedTools: false,
      handoffs: true,
      multiToolResponse: true,
      providerParallelToolControl: false,
      remoteConversation: false,
      serverCompaction: false,
    },
  }
}

function unavailableProvider(): ModelProviderDescriptor {
  return {
    ...deepSeek(),
    provider: 'disabled',
    displayName: '未配置服务',
    configured: false,
    defaultModel: null,
    availableModels: [],
    capabilities: [],
    agentRuntime: {
      ...deepSeek().agentRuntime,
      transport: 'none',
      structuredOutput: 'none',
      functionTools: false,
      localMcp: false,
      handoffs: false,
      multiToolResponse: false,
    },
  }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话工具调用渲染测试
//
//   文件:       conversationToolRendering.test.tsx
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ArtifactRef } from '@geo-agent-platform/shared-types'
import type { ConversationEntry } from '@geo-agent-platform/conversation-presentation'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ConversationEntryView } from '../features/conversation/ConversationEntry'

describe('conversation tool rendering', () => {
  it('shows the public tool label and registered identifier explicitly', () => {
    const html = renderToStaticMarkup(
      <ConversationEntryView
        entry={weatherEntry}
        entryVariants={{}}
        reducedMotion
        expandedIds={new Set()}
        onToggleExpanded={() => undefined}
        onSelectArtifact={() => undefined}
      />,
    )

    expect(html).toContain('查询公开天气')
    expect(html).toContain('已调用 · query_public_weather')
  })

  it('does not invent a display identifier for an unregistered tool', () => {
    const html = renderToStaticMarkup(
      <ConversationEntryView
        entry={{
          ...weatherEntry,
          commands: weatherEntry.commands?.map(command => ({
            ...command,
            title: '工具调用',
            displayIdentifier: null,
          })),
        }}
        entryVariants={{}}
        reducedMotion
        expandedIds={new Set()}
        onToggleExpanded={() => undefined}
        onSelectArtifact={() => undefined}
      />,
    )

    expect(html).toContain('工具调用')
    expect(html).not.toContain('query_public_weather')
  })

  it('renders authorized Artifact references as named blue links instead of internal ids', () => {
    const html = renderToStaticMarkup(
      <ConversationEntryView
        entry={{
          id: 'message_delivery',
          kind: 'message',
          role: 'assistant',
          timestamp: '2026-08-12T00:00:00.000Z',
          title: '回答',
          body: [
            '风险区划图（PNG）：artifact_risk_png',
            '区划图层（GeoJSON）：artifact_risk_geojson',
            '未授权引用：artifact_unknown',
          ].join('\n'),
          status: 'completed',
          details: { artifactIds: ['artifact_risk_png', 'artifact_risk_geojson'] },
        }}
        artifacts={deliveryArtifacts}
        entryVariants={{}}
        reducedMotion
        expandedIds={new Set()}
        onToggleExpanded={() => undefined}
        onSelectArtifact={() => undefined}
      />,
    )

    expect(html).toContain('href="#artifact/artifact_risk_png"')
    expect(html).toContain('href="#artifact/artifact_risk_geojson"')
    expect(html).toContain('class="cc-artifact-link"')
    expect(html).toContain('杭州短时强降水风险区划图.png')
    expect(html).toContain('杭州 13 区县风险分级.geojson')
    expect(html).not.toContain('：artifact_risk_png')
    expect(html).not.toContain('：artifact_risk_geojson')
    expect(html).toContain('：artifact_unknown')
  })
})

const weatherEntry: ConversationEntry = {
  id: 'tool:call_weather',
  kind: 'command_batch',
  timestamp: '2026-07-27T00:00:00.000Z',
  title: '查询公开天气',
  body: '杭州午后有阵雨。',
  status: 'completed',
  commands: [{
    id: 'call_weather',
    title: '查询公开天气',
    status: 'completed',
    body: '杭州午后有阵雨。',
    toolName: 'query_public_weather',
    displayIdentifier: 'query_public_weather',
    commandText: '{"location":"杭州"}',
    details: {
      args: { location: '杭州' },
      result: { summary: '杭州午后有阵雨。' },
    },
  }],
}

const deliveryArtifacts: ArtifactRef[] = [{
  artifactId: 'artifact_risk_png',
  runId: 'run_delivery',
  artifactType: 'chart_png',
  name: '杭州短时强降水风险区划图.png',
  uri: '/api/v1/results/artifact_risk_png/file',
  display: { surfaces: ['download'], primarySurface: 'download', map: null },
  metadata: {},
  isIntermediate: false,
}, {
  artifactId: 'artifact_risk_geojson',
  runId: 'run_delivery',
  artifactType: 'geojson',
  name: '杭州 13 区县风险分级.geojson',
  uri: '/api/v1/results/artifact_risk_geojson/file',
  display: { surfaces: ['download'], primarySurface: 'download', map: null },
  metadata: {},
  isIntermediate: false,
}]

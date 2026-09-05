// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层管理面板渲染测试
//
//   文件:       layerManagerPanel.test.tsx
//
//   日期:       2026年07月01日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LayerDescriptor } from '@geo-agent-platform/shared-types'
import { LayerPanel } from '../features/layers/LayerManagerPanel'
import { LayerNodeView } from '../features/layers/LayerManagerShared'
import type { LayerPanelView } from '../features/layers/useLayerManager'
import {
  createWorkspaceShellInspectorDetails,
  type WorkspaceInspectorDetailsInput,
} from '../app/workspaceInspectorDetails'

const noop = () => {}

describe('LayerPanel', () => {
  it('renders all seven layer manager views as real toolbar buttons', () => {
    // 工具栏是视图状态入口，不能退回装饰图标。
    const html = renderLayerPanel('drawOrder')

    for (const label of ['绘制顺序', '数据源', '选择', '样式', '添加', '标注', '属性表']) {
      expect(html).toContain(`aria-label="${label}"`)
    }
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('图层管理')
  })

  it('renders source layer actions from real reference layer data', () => {
    const html = renderLayerPanel('sources')

    expect(html).toContain('数据源')
    expect(html).toContain('杭州市行政区划')
    expect(html).toContain('MultiPolygon · 13 要素 · 已启用')
    expect(html).toContain('未加入地图')
    expect(html).toContain('加入地图')
    expect(html).toContain('导入 GeoJSON')
    expect(html).toContain('刷新')
    expect(html).toContain('停用')
    expect(html).toContain('替换')
    expect(html).toContain('删除')
  })

  it('shows explicit disabled reasons for unsupported style and label states', () => {
    expect(renderLayerPanel('style')).toContain('请选择一个结果图层后再调整样式')
    expect(renderLayerPanel('labels')).toContain('请选择一个矢量结果图层')
  })

  it('does not render non-existent basemap placeholders as manageable layers', () => {
    // 底图切换由地图画布负责；系统、托管和结果图层则统一来自 MapScene。
    const html = renderLayerPanel('drawOrder')

    expect(html).not.toContain('世界地形图')
    expect(html).not.toContain('全球山影')
    expect(html).toContain('底图仍由地图画布单独管理')
  })

  it('does not render a close action when the layer manager is the permanent Contents document', () => {
    const html = renderLayerPanel('drawOrder', false)

    expect(html).not.toContain('关闭图层管理面板')
  })

  it('assembles the permanent Contents detail without a close action in WorkspaceShell', () => {
    const { inspectorDetails, contentsDetails } = createWorkspaceShellInspectorDetails({
      panelMode: 'tools',
      layers: [],
      layerManager: {},
    } as unknown as WorkspaceInspectorDetailsInput)

    expect(inspectorDetails.panelMode).toBe('tools')
    expect(contentsDetails.panelMode).toBe('layerManager')
    expect(contentsDetails.onClose).toBeUndefined()
  })

  it('renders scientific raster legends from the manifest instead of assuming RGB bands', () => {
    const html = renderToStaticMarkup(
      <LayerNodeView
        node={{
          id: 'qpf-layer',
          name: '三小时累计降水',
          type: 'layer',
          layerKind: 'raster',
          visible: true,
          opacity: 0.9,
          geometrySummary: 'continuous_raster',
          legend: {
            kind: 'continuous',
            title: '累计降水',
            unit: 'mm',
            range: [0, 50],
            stops: [
              { value: 0, color: '#ffffff' },
              { value: 50, color: '#7f0000' },
            ],
            nodataLabel: '无数据',
          },
        }}
        depth={0}
        selectedId={null}
        onSelectLayer={noop}
        onToggleVisibility={noop}
        onToggleGroup={noop}
        onMoveLayer={noop}
        onMoveUp={noop}
        onMoveDown={noop}
        onZoomToLayer={noop}
        onRemoveLayer={noop}
      />,
    )

    expect(html).toContain('累计降水（mm）')
    expect(html).toContain('0 – 50 mm')
    expect(html).toContain('draggable="true"')
    expect(html).toContain('双击定位，Shift+F10 打开菜单')
    expect(html).not.toContain('R / Band 1')
    expect(html).not.toContain('RGB')
  })
})

function renderLayerPanel(activeView: LayerPanelView, closeable = true) {
  return renderToStaticMarkup(
    <LayerPanel
      tree={[]}
      selectedId={null}
      searchQuery=""
      totalCount={0}
      visibleCount={0}
      activeView={activeView}
      visibilityFilter="all"
      referenceLayers={[referenceLayer]}
      sceneManagedLayerKeys={[]}
      onSelectLayer={noop}
      onToggleVisibility={noop}
      onToggleAllVisibility={noop}
      onSetOpacity={noop}
      onRenameLayer={noop}
      onMoveUp={noop}
      onMoveDown={noop}
      onMoveLayer={noop}
      onRemoveLayer={noop}
      onCreateGroup={noop}
      onToggleGroup={noop}
      onSetSearchQuery={noop}
      onSetColor={noop}
      onZoomToLayer={noop}
      onExportLayer={noop}
      onSetActiveView={noop}
      onSetVisibilityFilter={noop}
      onSetLabelEnabled={noop}
      onSetLabelField={noop}
      onImportManagedLayer={noop}
      onReplaceManagedLayer={noop}
      onToggleReferenceLayerStatus={noop}
      onDeleteReferenceLayer={noop}
      onRefreshReferenceLayers={noop}
      onAddReferenceLayer={noop}
      onRemoveReferenceLayer={noop}
      onClose={closeable ? noop : undefined}
    />,
  )
}

const referenceLayer: LayerDescriptor = {
  mapLayerId: 'map_layer_managed_1',
  layerKey: 'hangzhou_districts',
  name: '杭州市行政区划',
  description: '系统内置杭州市区县边界。',
  sourceType: 'system',
  workspaceId: null,
  createdByUserId: null,
  visibility: 'public',
  readonly: true,
  category: 'boundary',
  geometryType: 'MultiPolygon',
  status: 'active',
  srid: 4326,
  featureCount: 13,
  bounds: [118.345, 29.1888, 120.7219, 30.5665],
  tags: ['杭州', '行政区划'],
  analysisCapabilities: ['query', 'spatial_join'],
  sourceConfigSummary: null,
  sessionId: null,
  threadId: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  propertySchema: [
    { name: 'name', dataType: 'string', populatedCount: 13, sampleValues: ['上城区'] },
  ],
  updatedAt: '2026-07-01T00:00:00.000Z',
} satisfies LayerDescriptor

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 详情图层概览面板
//
//   文件:       DetailLayerOverviewPanel.tsx
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 展示右侧详情栏里的结果图层与参考图层概览。
// 图层真实编辑能力仍在 LayerManagerPanel，本组件只提供快速查看和轻量操作入口。

import { Eye, EyeOff, LocateFixed } from 'lucide-react'

import type { ArtifactRef, LayerDescriptor } from '@geo-agent-platform/shared-types'

import { AppIcon } from '../../shared/components/AppIcon'

interface DetailLayerSummary {
  total: number
  active: number
  inactive: number
  managed: number
  session: number
  features: number
}

export interface DetailMapLayer {
  kind: 'geojson' | 'raster'
  artifact: ArtifactRef
  data?: GeoJSON.FeatureCollection
  imageUrl?: string
  coordinates?: [[number, number], [number, number], [number, number], [number, number]]
  visible: boolean
  opacity: number
  featureCount: number
  geometrySummary: string
}

interface DetailLayerOverviewPanelProps {
  layers: LayerDescriptor[]
  layerSummary: DetailLayerSummary
  mapLayers: DetailMapLayer[]
  selectedArtifact?: ArtifactRef
  onChangeArtifactOpacity: (artifactId: string, opacity: number) => void
  onSelectArtifact: (artifactId: string) => void
  onToggleArtifactVisibility: (artifactId: string) => void
}

export function DetailLayerOverviewPanel({
  layers,
  layerSummary,
  mapLayers,
  selectedArtifact,
  onChangeArtifactOpacity,
  onSelectArtifact,
  onToggleArtifactVisibility,
}: DetailLayerOverviewPanelProps) {
  // 图层概览渲染边界
  //
  // 只读参考图层和结果图层状态，所有显隐、透明度和定位动作继续回到父级控制器。
  return (
    <section className="dc-card">
      <div className="dc-card__header">
        <div>
          <div className="dc-card__eyebrow">图层</div>
          <h3>结果与参考图层</h3>
        </div>
        <div className="dc-card__icon">
          <AppIcon name="layers" size={18} />
        </div>
      </div>

      <div className="dc-panel-section">
        <div className="dc-keyvalue-list dc-keyvalue-list--compact">
          <div className="dc-keyvalue-row">
            <span>图层总数</span>
            <strong>{layerSummary.total}</strong>
          </div>
          <div className="dc-keyvalue-row">
            <span>活跃 / 停用</span>
            <strong>{layerSummary.active} / {layerSummary.inactive}</strong>
          </div>
          <div className="dc-keyvalue-row">
            <span>目录 / 会话</span>
            <strong>{layerSummary.managed} / {layerSummary.session}</strong>
          </div>
          <div className="dc-keyvalue-row">
            <span>要素总量</span>
            <strong>{layerSummary.features}</strong>
          </div>
        </div>
      </div>

      <div className="dc-panel-section">
        <div className="dc-panel-section__title">分析结果</div>
        <div className="dc-layer-manager">
          {mapLayers.length ? (
            mapLayers.map((layer) => (
              <article
                key={layer.artifact.artifactId}
                className={`dc-layer-manager__item${
                  layer.artifact.artifactId === selectedArtifact?.artifactId ? ' dc-layer-manager__item--active' : ''
                }`}
              >
                <div className="dc-layer-manager__top">
                  <button type="button" className="dc-layer-manager__main" onClick={() => onSelectArtifact(layer.artifact.artifactId)}>
                    <strong>{layer.artifact.name}</strong>
                    <span>
                      {layer.kind === 'raster' ? '1 张栅格' : `${layer.featureCount} 个对象`} · {layer.geometrySummary}
                    </span>
                  </button>
                  <div className="dc-layer-manager__actions">
                    <button
                      type="button"
                      className="dc-layer-manager__icon"
                      aria-label={layer.visible ? '隐藏图层' : '显示图层'}
                      onClick={() => onToggleArtifactVisibility(layer.artifact.artifactId)}
                    >
                      {layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                    </button>
                    <button
                      type="button"
                      className="dc-layer-manager__icon"
                      aria-label="定位到图层"
                      onClick={() => onSelectArtifact(layer.artifact.artifactId)}
                    >
                      <LocateFixed size={15} />
                    </button>
                  </div>
                </div>
                <div className="dc-layer-manager__meta">
                  <span className="dc-pill-meta">{layer.artifact.artifactType}</span>
                  <span className="dc-pill-meta">{layer.visible ? '显示中' : '已隐藏'}</span>
                  <span className="dc-pill-meta">透明度 {Math.round(layer.opacity * 100)}%</span>
                </div>
                <label className="dc-layer-manager__slider">
                  <span>图层透明度</span>
                  <input
                    type="range"
                    min={20}
                    max={100}
                    step={5}
                    value={Math.round(layer.opacity * 100)}
                    onChange={(event) => onChangeArtifactOpacity(layer.artifact.artifactId, Number(event.target.value) / 100)}
                  />
                </label>
              </article>
            ))
          ) : (
            <p className="dc-empty-copy">还没有生成结果图层，提交一次分析后这里会自动更新。</p>
          )}
        </div>
      </div>

      <div className="dc-panel-section">
        <div className="dc-panel-section__title">参考图层</div>
        <div className="dc-layer-reference-list">
          {layers.length ? (
            layers.map((layer) => (
              <div key={layer.layerKey} className="dc-layer-reference">
                <div className="dc-layer-reference__top">
                  <strong>{layer.name}</strong>
                  <span>
                    {layer.geometryType} · {layer.featureCount ?? 0} 要素 · {layerStatusLabel(layer.status)}
                  </span>
                </div>
                <div className="dc-layer-reference__meta">
                  <span className="dc-pill-meta">{layer.sourceType}</span>
                  <span className="dc-pill-meta">{layer.category || 'general'}</span>
                  <span className="dc-pill-meta">SRID {layer.srid}</span>
                  {(layer.tags ?? []).slice(0, 3).map((tag) => (
                    <span key={tag} className="dc-pill-meta">
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="dc-layer-reference__meta">
                  <span className="dc-pill-meta">{formatLayerBounds(layer.bounds)}</span>
                  <span className="dc-pill-meta">更新 {formatLayerUpdated(layer.updatedAt)}</span>
                </div>
                {layer.analysisCapabilities.length ? (
                  <div className="dc-layer-reference__meta">
                    {layer.analysisCapabilities.slice(0, 4).map((capability) => (
                      <span key={capability} className="dc-pill-meta">
                        {capability}
                      </span>
                    ))}
                  </div>
                ) : null}
                {(layer.propertySchema ?? []).length ? (
                  <div className="dc-layer-fields">
                    {(layer.propertySchema ?? []).slice(0, 4).map((field) => (
                      <span key={field.name}>
                        {field.name} · {field.dataType} · {field.populatedCount}
                      </span>
                    ))}
                  </div>
                ) : null}
                <p>{layer.description}</p>
                {layer.sourceConfigSummary ? <p>{layer.sourceConfigSummary}</p> : null}
              </div>
            ))
          ) : (
            <p className="dc-empty-copy">当前没有可展示的参考图层。</p>
          )}
        </div>
      </div>
    </section>
  )
}

function layerStatusLabel(status: string) {
  if (status === 'active') {
    return '活跃'
  }
  if (status === 'inactive') {
    return '停用'
  }
  return status || '未知'
}

function formatLayerBounds(bounds?: [number, number, number, number] | null) {
  if (!bounds) {
    return '无边界'
  }
  return bounds.map((item) => item.toFixed(4)).join(', ')
}

function formatLayerUpdated(timestamp?: string | null) {
  if (!timestamp) {
    return '--'
  }
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return timestamp
  }
  return parsed.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

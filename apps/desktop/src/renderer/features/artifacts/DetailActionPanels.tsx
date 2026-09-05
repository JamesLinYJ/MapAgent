// +-------------------------------------------------------------------------
//
//   地理智能平台 - 详情操作面板
//
//   文件:       DetailActionPanels.tsx
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 承载详情栏里的计算、导出和模型配置操作面板。
// 这些面板只触发父级注入的真实回调，不在本地伪造工具执行或系统状态。

import { Sparkles } from 'lucide-react'

import type { ArtifactRef, ModelProviderDescriptor, SystemComponentsStatus } from '@geo-agent-platform/shared-types'

import { AppIcon } from '../../shared/components/AppIcon'
import { providerUnavailableLabel, supportsAgentSdkLiveSupervisor } from '../../shared/providerCapabilities'
import type { DetailMapLayer } from './DetailLayerOverviewPanel'

interface DetailComputePanelProps {
  isToolSubmitting: boolean
  mapLayers: DetailMapLayer[]
  selectedArtifact?: ArtifactRef
  selectedCollection?: GeoJSON.FeatureCollection
  onExportResults: () => void
  onSelectArtifact: (artifactId: string) => void
  onToggleArtifactVisibility: (artifactId: string) => void
}

export function DetailComputePanel({
  isToolSubmitting,
  mapLayers,
  selectedArtifact,
  selectedCollection,
  onExportResults,
  onSelectArtifact,
  onToggleArtifactVisibility,
}: DetailComputePanelProps) {
  return (
    <section className="dc-card">
      <div className="dc-card__header">
        <div>
          <div className="dc-card__eyebrow">计算</div>
          <h3>继续处理当前结果</h3>
        </div>
        <div className="dc-card__icon">
          <Sparkles size={18} aria-hidden="true" />
        </div>
      </div>

      <div className="dc-action-grid">
        <button
          type="button"
          className="dc-action-button dc-action-button--primary"
          disabled={!selectedArtifact || isToolSubmitting}
          onClick={onExportResults}
        >
          导出当前成果
        </button>
        <button
          type="button"
          className="dc-action-button"
          disabled={!selectedArtifact}
          onClick={() => selectedArtifact && onSelectArtifact(selectedArtifact.artifactId)}
        >
          定位当前结果
        </button>
        <button
          type="button"
          className="dc-action-button"
          disabled={!selectedArtifact}
          onClick={() => selectedArtifact && onToggleArtifactVisibility(selectedArtifact.artifactId)}
        >
          切换结果可见性
        </button>
      </div>

      <div className="dc-panel-section">
        <div className="dc-keyvalue-list">
          <div className="dc-keyvalue-row">
            <span>当前工具状态</span>
            <strong>{isToolSubmitting ? '执行中' : '待命'}</strong>
          </div>
          <div className="dc-keyvalue-row">
            <span>可见结果</span>
            <strong>{mapLayers.filter((layer) => layer.visible).length}</strong>
          </div>
        </div>
      </div>

      <div className="dc-panel-section">
        <div className="dc-panel-section__title">当前选择</div>
        <div className="dc-panel-list">
          {selectedArtifact ? (
            <div className="dc-panel-item dc-panel-item--static">
              <div>
                <strong>{selectedArtifact.name}</strong>
                <span>{selectedCollection?.features.length ?? 0} 个对象可继续分析</span>
              </div>
              <span className="dc-pill-meta">当前结果</span>
            </div>
          ) : (
            <p className="dc-empty-copy">请先在“图层”或“结果摘要”中选择一个结果图层。</p>
          )}
        </div>
      </div>
    </section>
  )
}

export function DetailExportPanel({
  selectedArtifact,
  onDownloadArtifact,
  onExportResults,
}: {
  selectedArtifact?: ArtifactRef
  onDownloadArtifact: () => void
  onExportResults: () => void
}) {
  return (
    <section className="dc-card">
      <div className="dc-card__header">
        <div>
          <div className="dc-card__eyebrow">导出</div>
          <h3>下载与分享</h3>
        </div>
        <div className="dc-card__icon">
          <AppIcon name="ios_share" size={18} />
        </div>
      </div>

      <div className="dc-action-grid">
        {selectedArtifact ? (
          <button
            type="button"
            className="dc-action-button dc-action-button--primary"
            onClick={onDownloadArtifact}
          >
            {selectedArtifact.artifactType === 'geojson' ? 'GeoJSON 下载' : '文件下载'}
          </button>
        ) : (
          <button type="button" className="dc-action-button dc-action-button--primary" disabled>
            先生成结果
          </button>
        )}

        <button type="button" className="dc-action-button" onClick={onExportResults}>
          导出 PDF、地图与数据包
        </button>
      </div>
    </section>
  )
}

export function DetailConfigPanel({
  model,
  provider,
  providers,
  systemComponents,
  onModelChange,
  onProviderChange,
}: {
  model: string
  provider: string
  providers: ModelProviderDescriptor[]
  systemComponents?: SystemComponentsStatus
  onModelChange: (value: string) => void
  onProviderChange: (value: string) => void
}) {
  return (
    <>
      <section className="dc-card">
        <div className="dc-card__header">
          <div>
            <div className="dc-card__eyebrow">模型配置</div>
            <h3>当前分析引擎</h3>
          </div>
          <div className="dc-card__icon">
            <AppIcon name="tune" size={18} />
          </div>
        </div>

        <div className="dc-form-grid">
          <label className="dc-field">
            <span>模型 Provider</span>
            <select value={provider} onChange={(event) => onProviderChange(event.target.value)}>
              {providers.map((item) => (
                <option key={item.provider} value={item.provider} disabled={!supportsAgentSdkLiveSupervisor(item)}>
                  {item.displayName}
                  {providerUnavailableLabel(item)}
                </option>
              ))}
            </select>
          </label>

          <label className="dc-field">
            <span>模型名称</span>
            <input value={model} placeholder="留空使用默认模型" onChange={(event) => onModelChange(event.target.value)} />
          </label>
        </div>
      </section>

      <section className="dc-card">
        <div className="dc-card__header">
          <div>
            <div className="dc-card__eyebrow">运行组件</div>
            <h3>系统状态</h3>
          </div>
          <div className="dc-card__icon">
            <AppIcon name="deployed_code" size={18} />
          </div>
        </div>

        <div className="dc-keyvalue-list">
          <div className="dc-keyvalue-row">
            <span>图层目录</span>
            <strong>{systemComponents?.catalogBackend ?? '载入中'}</strong>
          </div>
          <div className="dc-keyvalue-row">
            <span>PostGIS</span>
            <strong title={systemComponents?.postgisError ?? undefined}>
              {systemComponents?.postgisEnabled ? '已接入' : '未接入'}
            </strong>
          </div>
          <div className="dc-keyvalue-row">
            <span>诊断载荷</span>
            <strong>{systemComponents?.payloadStoreRoot ? '已启用' : '载入中'}</strong>
          </div>
        </div>
      </section>
    </>
  )
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 详情摘要面板
//
//   文件:       DetailSummaryPanel.tsx
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 渲染右侧详情栏的结果摘要、智能建议和 Agent SDK 只读状态。
// 输入数据必须由 DetailPanel 先推导完成，本组件不拥有运行状态事实源。

import { Lightbulb, MapPin, Sparkles } from 'lucide-react'

import type { AgentState, ArtifactRef } from '@geo-agent-platform/shared-types'

import { AppIcon } from '../../shared/components/AppIcon'
import type { DetailSummaryFact } from './detailSummaryModel'

interface ResultCardLabel {
  title: string
  subtitle: string
}

interface DetailSummaryPanelProps {
  artifactData: Record<string, GeoJSON.FeatureCollection>
  approvals: NonNullable<AgentState['approvals']>
  cardLabels: ResultCardLabel[]
  primaryItems: ArtifactRef[]
  selectedArtifact?: ArtifactRef
  selectedCollection?: GeoJSON.FeatureCollection
  selectedFileUrl: string | null
  subAgents: NonNullable<AgentState['subAgents']>
  summaryBody: string
  summaryFacts: DetailSummaryFact[]
  summaryTitle: string
  todoItems: NonNullable<AgentState['todos']>
  onDownloadArtifact: () => void
  onExportResults: () => void
  onSelectArtifact: (artifactId: string) => void
}

export function DetailSummaryPanel({
  artifactData,
  approvals,
  cardLabels,
  primaryItems,
  selectedArtifact,
  selectedCollection,
  selectedFileUrl,
  subAgents,
  summaryBody,
  summaryFacts,
  summaryTitle,
  todoItems,
  onDownloadArtifact,
  onExportResults,
  onSelectArtifact,
}: DetailSummaryPanelProps) {
  // 摘要渲染边界
  //
  // 结果事实、运行状态和建议文案都来自父组件推导后的 view model；
  // 这里仅负责稳定渲染，避免详情栏主组件继续膨胀。
  return (
    <>
      <section className="dc-card dc-card--summary">
        <div className="dc-card__header">
          <div>
            <div className="dc-card__eyebrow">结果摘要</div>
            <h3>{summaryTitle}</h3>
          </div>
          <div className="dc-card__icon">
            <AppIcon name="analytics" size={18} />
          </div>
        </div>

        <div className="dc-summary-grid" aria-label="结果概览">
          {summaryFacts.map(item => (
            <div key={item.label} className="dc-summary-fact">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>

        {selectedArtifact ? (
          <div className="dc-current-result">
            <span>当前结果</span>
            <strong>{selectedArtifact.name}</strong>
            <p>{cardLabels[primaryItems.findIndex(item => item.artifactId === selectedArtifact.artifactId)]?.subtitle ?? `${selectedCollection?.features.length ?? 0} 个对象可继续分析`}</p>
          </div>
        ) : null}

        <div className="dc-result-list">
          {primaryItems.length ? (
            primaryItems.map((artifact, index) => (
              <button
                key={artifact.artifactId}
                className={`dc-result-item${artifact.artifactId === selectedArtifact?.artifactId ? ' dc-result-item--active' : ''}`}
                type="button"
                onClick={() => onSelectArtifact(artifact.artifactId)}
              >
                <div className={`dc-result-thumb dc-result-thumb--${index % 2 === 0 ? 'graphite' : 'orange'}`} />
                <div className="dc-result-item__copy">
                  <strong>{cardLabels[index]?.title ?? artifact.name}</strong>
                  <span>{cardLabels[index]?.subtitle ?? `${artifactData[artifact.artifactId]?.features.length ?? 0} 个对象已就绪`}</span>
                </div>
              </button>
            ))
          ) : (
            <p className="dc-empty-copy">分析完成后，结果图层和摘要会出现在这里。</p>
          )}
        </div>

        {selectedArtifact?.artifactType === 'chart_png' && selectedFileUrl ? (
          <img className="mt-4 w-full rounded-lg border border-slate-200 bg-white" src={selectedFileUrl} alt={selectedArtifact.name} />
        ) : null}

        {selectedArtifact ? (
          <div className="dc-card__actions">
            <button
              type="button"
              className="dc-link-button"
              onClick={onDownloadArtifact}
            >
              {selectedArtifact.artifactType === 'geojson' ? 'GeoJSON 下载' : '文件下载'}
            </button>
            <button
              className="dc-link-button dc-link-button--primary"
              type="button"
              onClick={onExportResults}
            >
              导出成果
            </button>
          </div>
        ) : null}
      </section>

      <section className="dc-card dc-card--suggestions">
        <div className="dc-card__eyebrow">智能建议</div>
        <div className="dc-advice-list">
          <article className="dc-advice">
            <div className="dc-advice__title">
              <Lightbulb size={16} aria-hidden="true" />
              <strong>结果解读</strong>
            </div>
            <p>{summaryBody}</p>
          </article>

          <article className="dc-advice">
            <div className="dc-advice__title">
              <MapPin size={16} aria-hidden="true" />
              <strong>下一步建议</strong>
            </div>
            <p>你可以继续切换结果图层、下载数据，或在对话里要求追加缓冲、相交、统计等分析。</p>
          </article>
        </div>
      </section>

      {todoItems.length || subAgents.length || approvals.length ? (
        <section className="dc-card">
          <div className="dc-card__header">
            <div>
              <div className="dc-card__eyebrow">运行状态</div>
              <h3>Agent SDK 状态</h3>
            </div>
            <div className="dc-card__icon">
              <Sparkles size={18} aria-hidden="true" />
            </div>
          </div>

          {todoItems.length ? (
            <div className="dc-panel-section">
              <div className="dc-panel-section__title">待办清单</div>
              <div className="dc-panel-list">
                {todoItems.slice(0, 4).map((todo) => (
                  <div key={todo.todoId} className="dc-panel-item dc-panel-item--static">
                    <div>
                      <strong>{todo.title}</strong>
                      <span>{todo.description ?? '系统正在持续更新这个待办的执行状态。'}</span>
                    </div>
                    <span className="dc-pill-meta">{todo.status}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {subAgents.length ? (
            <div className="dc-panel-section">
              <div className="dc-panel-section__title">子智能体</div>
              <div className="dc-panel-list">
                {subAgents.map((agent) => (
                  <div key={agent.agentId} className="dc-panel-item dc-panel-item--static">
                    <div>
                      <strong>{agent.name}</strong>
                      <span>{agent.latestMessage ?? agent.summary}</span>
                    </div>
                    <span className="dc-pill-meta">{agent.status}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {approvals.length ? (
            <div className="dc-panel-section">
              <div className="dc-panel-section__title">审批</div>
              <div className="dc-panel-list">
                {approvals.map((approval) => (
                  <div key={approval.approvalId} className="dc-panel-item dc-panel-item--static">
                    <div>
                      <strong>{approval.title}</strong>
                      <span>{approval.description}</span>
                    </div>
                    <div className="dc-card__actions">
                      <span className="dc-pill-meta">{approval.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  )
}

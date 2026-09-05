// +-------------------------------------------------------------------------
//
//   地理智能平台 - 受限工作台面板
//
//   文件:       WorkspaceRestrictedPanels.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  CloudOff,
  Database,
  Layers3,
  LockKeyhole,
  Map as MapIcon,
  RefreshCw,
  Send,
} from 'lucide-react'

interface RestrictedPanelProps {
  reason: string
  onRetry: () => void
}

/**
 * 后台不可用时保留完整对话区域，但不挂载任何可写的远程动作。
 */
export function WorkspaceRestrictedConversation({
  reason,
  onRetry,
}: RestrictedPanelProps) {
  return (
    <section className="cc-panel gf-restricted-conversation" aria-label="智能对话暂不可用">
      <div className="gf-restricted-conversation__body" role="status">
        <span className="gf-restricted-conversation__mark" aria-hidden="true">
          <LockKeyhole size={22} />
        </span>
        <strong>远程分析已安全暂停</strong>
        <p>{reason}</p>
        <button type="button" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" />
          重新检查
        </button>
      </div>

      <div className="cc-composer gf-restricted-composer">
        <textarea
          className="cc-composer-input"
          aria-label="输入空间分析需求"
          placeholder="服务恢复并完成认证后即可输入消息"
          disabled
          rows={1}
        />
        <div className="cc-composer-toolbar">
          <span className="cc-composer-provider">离线模式</span>
          <button
            className="cc-composer-tool cc-composer-tool--send"
            type="button"
            aria-label="发送暂不可用"
            title={reason}
            disabled
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </section>
  )
}

export function WorkspaceRestrictedContents({
  basemapName,
  reason,
}: {
  basemapName: string
  reason: string
}) {
  return (
    <section className="gf-restricted-contents" aria-label="本地图层视图">
      <div className="gf-restricted-contents__heading">
        <Layers3 size={15} aria-hidden="true" />
        <strong>绘制顺序</strong>
      </div>
      <div className="gf-restricted-layer-tree" role="tree" aria-label="本地图层树">
        <div role="treeitem" aria-expanded="true">
          <MapIcon size={14} aria-hidden="true" />
          <strong>地图</strong>
        </div>
        <div role="treeitem" aria-disabled="true">
          <span className="gf-restricted-layer-swatch" aria-hidden="true" />
          <span>{basemapName}</span>
          <small>本地底图配置</small>
        </div>
      </div>
      <div className="gf-restricted-contents__notice" role="status">
        <Database size={15} aria-hidden="true" />
        <p>{reason}</p>
      </div>
    </section>
  )
}

export function WorkspaceRestrictedDocument({
  title,
  reason,
}: {
  title: string
  reason: string
}) {
  return (
    <section className="gf-document-unavailable gf-document-unavailable--restricted" role="status">
      <CloudOff size={24} aria-hidden="true" />
      <strong>{title}暂不可用</strong>
      <span>{reason}</span>
    </section>
  )
}

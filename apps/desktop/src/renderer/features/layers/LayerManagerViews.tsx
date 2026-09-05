// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层管理视图组件
//
//   文件:       LayerManagerViews.tsx
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import {
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  FolderPlus,
  Layers3,
  LocateFixed,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react'
import { useState } from 'react'
import type { LayerDescriptor } from '@geo-agent-platform/shared-types'
import type { DesktopFileSelectionHandle } from '../../../contracts/desktopIpc'
import { selectDesktopLayerFile } from '../../api/desktopFiles'
import { requireDesktopBridge } from '../../api/transport'
import type { LayerTreeNode } from './useLayerManager'
import {
  LayerDetails,
  LayerNodeView,
  ReferenceLayerDetails,
} from './LayerManagerShared'
import { formatLayerBounds, formatLayerKind } from './layerManagerFormatters'

interface DrawOrderViewProps {
  tree: LayerTreeNode[]
  selectedId: string | null
  selectedNode?: LayerTreeNode
  selectableLayerIds: string[]
  groupName: string
  onGroupNameChange: (value: string) => void
  onSelectLayer: (id: string | null) => void
  onToggleVisibility: (id: string) => void
  onToggleAllVisibility: () => void
  onSetOpacity: (id: string, opacity: number) => void
  onRenameLayer: (id: string, name: string) => void
  onMoveUp: (id: string) => void
  onMoveDown: (id: string) => void
  onMoveLayer: (id: string, targetId: string) => void
  onRemoveLayer: (id: string) => void
  onCreateGroup: (name: string, memberIds: string[]) => void
  onToggleGroup: (id: string) => void
  onSetColor: (id: string, color: string) => void
  onZoomToLayer: (id: string) => void
  onExportLayer: (id: string) => void
}

export function DrawOrderView({
  tree,
  selectedId,
  selectedNode,
  selectableLayerIds,
  groupName,
  onGroupNameChange,
  onSelectLayer,
  onToggleVisibility,
  onToggleAllVisibility,
  onSetOpacity,
  onRenameLayer,
  onMoveUp,
  onMoveDown,
  onMoveLayer,
  onRemoveLayer,
  onCreateGroup,
  onToggleGroup,
  onSetColor,
  onZoomToLayer,
  onExportLayer,
}: DrawOrderViewProps) {
  return (
    <>
      <div className="arcgis-layer-panel__section-title">绘制顺序</div>
      <div className="arcgis-layer-panel__tree" role="tree" aria-label="地图图层树">
        <div className="arcgis-layer-panel__map-root" role="treeitem" aria-expanded="true">
          <ChevronDown size={15} aria-hidden="true" />
          <span className="arcgis-layer-panel__map-icon" aria-hidden="true" />
          <strong>地图</strong>
        </div>
        {tree.length ? tree.map(node => (
          <LayerNodeView
            key={node.id}
            node={node}
            depth={0}
            selectedId={selectedId}
            onSelectLayer={onSelectLayer}
            onToggleVisibility={onToggleVisibility}
            onToggleGroup={onToggleGroup}
            onMoveLayer={onMoveLayer}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onZoomToLayer={onZoomToLayer}
            onRemoveLayer={onRemoveLayer}
          />
        )) : (
          <div className="arcgis-layer-panel__empty">
            <strong>暂无可管理图层</strong>
            <span>创建对话或添加数据后，系统图层、托管图层和分析结果会统一出现在这里。底图仍由地图画布单独管理。</span>
          </div>
        )}
      </div>

      <SelectedLayerEditor
        selectedNode={selectedNode}
        selectableLayerIds={selectableLayerIds}
        groupName={groupName}
        onGroupNameChange={onGroupNameChange}
        onToggleAllVisibility={onToggleAllVisibility}
        onSetOpacity={onSetOpacity}
        onRenameLayer={onRenameLayer}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onRemoveLayer={onRemoveLayer}
        onCreateGroup={onCreateGroup}
        onSetColor={onSetColor}
        onZoomToLayer={onZoomToLayer}
        onExportLayer={onExportLayer}
      />
    </>
  )
}

function SelectedLayerEditor({
  selectedNode,
  selectableLayerIds,
  groupName,
  onGroupNameChange,
  onToggleAllVisibility,
  onSetOpacity,
  onRenameLayer,
  onMoveUp,
  onMoveDown,
  onRemoveLayer,
  onCreateGroup,
  onSetColor,
  onZoomToLayer,
  onExportLayer,
}: Omit<
  DrawOrderViewProps,
  'tree' | 'selectedId' | 'onSelectLayer' | 'onToggleVisibility' | 'onToggleGroup' | 'onMoveLayer'
>) {
  const selectedIsRaster = selectedNode?.type === 'layer' && selectedNode.layerKind === 'raster'
  const selectedIsGroup = selectedNode?.type === 'group'
  return (
    <>
      <div className="arcgis-layer-panel__selected">
        <div className="arcgis-layer-panel__selected-heading">
          <div>
            <strong>所选图层</strong>
            <span>{selectedNode?.name ?? '未选择图层'}</span>
          </div>
          <small>{selectedNode ? formatLayerKind(selectedNode) : '请选择绘制顺序中的图层'}</small>
        </div>
        <div className="arcgis-layer-panel__selected-actions">
          <button type="button" onClick={onToggleAllVisibility} disabled={!selectableLayerIds.length}>批量显隐</button>
          <button type="button" onClick={() => selectedNode && onMoveUp(selectedNode.id)} disabled={!selectedNode || selectedIsGroup}>上移</button>
          <button type="button" onClick={() => selectedNode && onMoveDown(selectedNode.id)} disabled={!selectedNode || selectedIsGroup}>下移</button>
          <button type="button" onClick={() => selectedNode && onZoomToLayer(selectedNode.id)} disabled={!selectedNode || selectedNode.type === 'group'}>
            <LocateFixed size={13} /> 定位
          </button>
          <button type="button" onClick={() => selectedNode && onExportLayer(selectedNode.id)} disabled={!selectedNode || selectedNode.type === 'group'}>
            <Download size={13} /> 导出
          </button>
          <button type="button" onClick={() => selectedNode && onRemoveLayer(selectedNode.id)} disabled={!selectedNode || selectedNode.type === 'group'}>
            <Trash2 size={13} /> 移除
          </button>
        </div>
        {selectedNode ? (
          <div className="arcgis-layer-panel__selected-editor">
            <label>
              <span>名称</span>
              <input value={selectedNode.name} onChange={(event) => onRenameLayer(selectedNode.id, event.target.value)} />
            </label>
            <label>
              <span>透明度 {Math.round(selectedNode.opacity * 100)}%</span>
              <input
                type="range"
                min={10}
                max={100}
                value={Math.round(selectedNode.opacity * 100)}
                onChange={(event) => onSetOpacity(selectedNode.id, Number(event.target.value) / 100)}
              />
            </label>
            {selectedNode.type === 'layer' ? (
              <label>
                <span>{selectedIsRaster ? '栅格色调' : '符号颜色'}</span>
                <input
                  type="color"
                  value={selectedNode.color ?? '#2563eb'}
                  onChange={(event) => onSetColor(selectedNode.id, event.target.value)}
                />
              </label>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="arcgis-layer-panel__grouping">
        <label>
          <span>新建分组</span>
          <input value={groupName} placeholder="例如：强降水产品" onChange={(event) => onGroupNameChange(event.target.value)} />
        </label>
        <button
          type="button"
          onClick={() => {
            onCreateGroup(groupName, selectedNode?.type === 'layer' ? [selectedNode.id] : selectableLayerIds)
            onGroupNameChange('')
          }}
          disabled={!groupName.trim() || !selectableLayerIds.length}
        >
          <FolderPlus size={15} /> 建立分组
        </button>
      </div>
    </>
  )
}

export function SourcesView({
  referenceLayers,
  selectedReferenceKey,
  onSelectReference,
  onImportManagedLayer,
  onReplaceManagedLayer,
  onToggleReferenceLayerStatus,
  onDeleteReferenceLayer,
  onRefreshReferenceLayers,
  sceneManagedLayerKeys,
  onAddReferenceLayer,
  onRemoveReferenceLayer,
}: {
  referenceLayers: LayerDescriptor[]
  selectedReferenceKey: string | null
  onSelectReference: (layerKey: string) => void
  onImportManagedLayer: (file: DesktopFileSelectionHandle) => void
  onReplaceManagedLayer: (layerKey: string, file: DesktopFileSelectionHandle) => void
  onToggleReferenceLayerStatus: (layerKey: string, nextStatus: string) => void
  onDeleteReferenceLayer: (layerKey: string) => void
  onRefreshReferenceLayers: () => void
  sceneManagedLayerKeys: string[]
  onAddReferenceLayer: (layerKey: string) => void
  onRemoveReferenceLayer: (layerKey: string) => void
}) {
  return (
    <div className="arcgis-layer-details">
      <header>
        <strong>数据源</strong>
        <span>{referenceLayers.length} 个参考图层</span>
      </header>
      <div className="arcgis-layer-panel__selected-actions">
        <NativeLayerFileButton
          className="arcgis-layer-panel__file-action"
          iconSize={13}
          label="导入 GeoJSON"
          onFile={onImportManagedLayer}
        />
        <button type="button" onClick={onRefreshReferenceLayers}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>
      {referenceLayers.length ? (
        <div className="arcgis-layer-source-list">
          {referenceLayers.map(layer => {
            const active = layer.status === 'active'
            const inScene = sceneManagedLayerKeys.includes(layer.layerKey)
            return (
              <article key={layer.layerKey} className={`arcgis-layer-source${selectedReferenceKey === layer.layerKey ? ' is-selected' : ''}`}>
                <button type="button" className="arcgis-layer-source__main" onClick={() => onSelectReference(layer.layerKey)}>
                  <strong>{layer.name}</strong>
                  <span>{layer.geometryType} · {layer.featureCount ?? 0} 要素 · {active ? '已启用' : '已停用'} · {inScene ? '已加入地图' : '未加入地图'}</span>
                </button>
                <div className="arcgis-layer-source__meta">
                  <span>{layer.sourceType}</span>
                  <span>{layer.category || 'general'}</span>
                  <span>SRID {layer.srid}</span>
                  <span>{formatLayerBounds(layer.bounds)}</span>
                </div>
                <div className="arcgis-layer-panel__selected-actions">
                  <button
                    type="button"
                    onClick={() => inScene ? onRemoveReferenceLayer(layer.layerKey) : onAddReferenceLayer(layer.layerKey)}
                    disabled={!inScene && !active}
                    title={!inScene && !active ? '请先启用数据源' : undefined}
                  >
                    <Layers3 size={13} /> {inScene ? '从地图移除' : '加入地图'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleReferenceLayerStatus(layer.layerKey, active ? 'inactive' : 'active')}
                    disabled={layer.readonly || inScene}
                    title={layer.readonly ? '系统数据源只读' : inScene ? '请先从地图移除' : undefined}
                  >
                    {active ? <EyeOff size={13} /> : <Eye size={13} />} {active ? '停用' : '启用'}
                  </button>
                  <NativeLayerFileButton
                    className={`arcgis-layer-panel__file-action${layer.readonly ? ' is-disabled' : ''}`}
                    disabled={layer.readonly}
                    iconSize={13}
                    label="替换"
                    title={layer.readonly ? '系统数据源只读' : undefined}
                    onFile={file => onReplaceManagedLayer(layer.layerKey, file)}
                  />
                  <button type="button" disabled={layer.readonly || inScene} title={layer.readonly ? '系统数据源只读' : inScene ? '请先从地图移除' : undefined} onClick={() => onDeleteReferenceLayer(layer.layerKey)}>
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
                {selectedReferenceKey === layer.layerKey ? <ReferenceLayerDetails layer={layer} /> : null}
              </article>
            )
          })}
        </div>
      ) : (
        <p className="arcgis-layer-details__empty-table">当前没有参考图层。可以导入 GeoJSON 建立数据源。</p>
      )}
    </div>
  )
}

export function SelectionView({
  selectedNode,
  selectedReferenceLayer,
  onZoomToLayer,
  onExportLayer,
}: {
  selectedNode?: LayerTreeNode
  selectedReferenceLayer?: LayerDescriptor
  onZoomToLayer: (id: string) => void
  onExportLayer: (id: string) => void
}) {
  const [copyStatus, setCopyStatus] = useState('')

  const copyLayerId = async (layerId: string) => {
    try {
      await requireDesktopBridge().clipboard.writeText(layerId)
      setCopyStatus('图层标识已复制')
    } catch (error) {
      setCopyStatus(error instanceof Error ? `复制失败：${error.message}` : '复制失败。')
    }
  }

  return (
    <div className="arcgis-layer-details">
      <header>
        <strong>选择</strong>
        <span>{selectedNode ? '结果图层' : selectedReferenceLayer ? '参考图层' : '未选择'}</span>
      </header>
      {selectedNode ? (
        <>
          <LayerDetails node={selectedNode} compact />
          <div className="arcgis-layer-panel__selected-actions">
            <button type="button" onClick={() => onZoomToLayer(selectedNode.id)} disabled={selectedNode.type === 'group'}><LocateFixed size={13} /> 定位</button>
            <button type="button" onClick={() => onExportLayer(selectedNode.id)} disabled={selectedNode.type === 'group'}><Download size={13} /> 导出</button>
            <button type="button" onClick={() => void copyLayerId(selectedNode.id)}>复制图层标识</button>
          </div>
          {copyStatus ? <p className="arcgis-layer-details__empty-table" role="status">{copyStatus}</p> : null}
        </>
      ) : selectedReferenceLayer ? (
        <ReferenceLayerDetails layer={selectedReferenceLayer} />
      ) : (
        <p className="arcgis-layer-details__empty-table">请选择一个结果图层或数据源图层。</p>
      )}
    </div>
  )
}

export function StyleView({
  selectedNode,
  onSetColor,
  onSetOpacity,
}: {
  selectedNode?: LayerTreeNode
  onSetColor: (id: string, color: string) => void
  onSetOpacity: (id: string, opacity: number) => void
}) {
  return (
    <div className="arcgis-layer-details">
      <header>
        <strong>样式</strong>
        <span>{selectedNode?.name ?? '未选择图层'}</span>
      </header>
      {selectedNode?.type === 'layer' ? (
        <div className="arcgis-layer-panel__selected-editor">
          <label>
            <span>{selectedNode.layerKind === 'raster' ? '栅格色调' : '符号颜色'}</span>
            <input type="color" value={selectedNode.color ?? '#2563eb'} onChange={(event) => onSetColor(selectedNode.id, event.target.value)} />
          </label>
          <label>
            <span>透明度 {Math.round(selectedNode.opacity * 100)}%</span>
            <input type="range" min={10} max={100} value={Math.round(selectedNode.opacity * 100)} onChange={(event) => onSetOpacity(selectedNode.id, Number(event.target.value) / 100)} />
          </label>
          <p className="arcgis-layer-details__empty-table">
            {selectedNode.layerKind === 'raster' ? '栅格暂支持整体透明度和色调调整。分级渲染需要后端提供栅格统计后再启用。' : '矢量图层支持统一颜色、透明度和属性字段标注。'}
          </p>
        </div>
      ) : (
        <p className="arcgis-layer-details__empty-table">请选择一个结果图层后再调整样式。图层组不支持直接设置符号。</p>
      )}
    </div>
  )
}

export function AddView({
  onImportManagedLayer,
}: {
  onImportManagedLayer: (file: DesktopFileSelectionHandle) => void
}) {
  return (
    <div className="arcgis-layer-details">
      <header>
        <strong>添加图层</strong>
        <span>GeoJSON / JSON</span>
      </header>
      <p className="arcgis-layer-details__empty-table">导入的文件会进入参考图层目录，并可被后续空间查询和图层列表读取。</p>
      <NativeLayerFileButton
        className="arcgis-layer-panel__large-file-action"
        iconSize={16}
        label="选择 GeoJSON 文件"
        onFile={onImportManagedLayer}
      />
    </div>
  )
}

function NativeLayerFileButton({
  className,
  disabled = false,
  iconSize,
  label,
  onFile,
  title,
}: {
  className: string
  disabled?: boolean
  iconSize: number
  label: string
  onFile: (file: DesktopFileSelectionHandle) => void
  title?: string
}) {
  const [selectionError, setSelectionError] = useState<string | null>(null)
  return (
    <span className="arcgis-layer-panel__native-file">
      <button
        type="button"
        className={className}
        disabled={disabled}
        title={title}
        onClick={() => {
          void selectDesktopLayerFile()
            .then((file) => {
              setSelectionError(null)
              if (file) onFile(file)
            })
            .catch((error: unknown) => {
              setSelectionError(error instanceof Error ? error.message : '图层文件选择失败，请重试。')
            })
        }}
      >
        <Upload size={iconSize} /> {label}
      </button>
      {selectionError ? (
        <span className="arcgis-layer-panel__file-error" role="alert">{selectionError}</span>
      ) : null}
    </span>
  )
}

export function LabelsView({
  selectedNode,
  onSetLabelEnabled,
  onSetLabelField,
}: {
  selectedNode?: LayerTreeNode
  onSetLabelEnabled: (id: string, enabled: boolean) => void
  onSetLabelField: (id: string, fieldName: string) => void
}) {
  const fields = selectedNode?.fieldNames ?? []
  const canLabel = selectedNode?.type === 'layer' && selectedNode.layerKind === 'geojson' && fields.length > 0
  return (
    <div className="arcgis-layer-details">
      <header>
        <strong>标注</strong>
        <span>{selectedNode?.name ?? '未选择图层'}</span>
      </header>
      {canLabel && selectedNode ? (
        <div className="arcgis-layer-panel__selected-editor">
          <label>
            <span>启用标签</span>
            <input type="checkbox" checked={Boolean(selectedNode.labelEnabled)} onChange={(event) => onSetLabelEnabled(selectedNode.id, event.target.checked)} />
          </label>
          <label>
            <span>标签字段</span>
            <select value={selectedNode.labelField ?? fields[0]} onChange={(event) => onSetLabelField(selectedNode.id, event.target.value)}>
              {fields.map(field => <option key={field} value={field}>{field}</option>)}
            </select>
          </label>
          <p className="arcgis-layer-details__empty-table">标签会以地图 symbol layer 渲染，只读取当前图层已有属性字段。</p>
        </div>
      ) : (
        <p className="arcgis-layer-details__empty-table">
          {!selectedNode ? '请选择一个矢量结果图层。' : selectedNode.layerKind === 'raster' ? '栅格图层没有要素字段，不能生成标签。' : '当前图层没有可用字段。'}
        </p>
      )}
    </div>
  )
}

export function TableView({
  selectedNode,
  selectedReferenceLayer,
}: {
  selectedNode?: LayerTreeNode
  selectedReferenceLayer?: LayerDescriptor
}) {
  return (
    <div className="arcgis-layer-details">
      <header>
        <strong>属性表</strong>
        <span>{selectedNode?.name ?? selectedReferenceLayer?.name ?? '未选择图层'}</span>
      </header>
      {selectedNode?.type === 'layer' ? (
        <LayerDetails node={selectedNode} />
      ) : selectedReferenceLayer ? (
        <ReferenceLayerDetails layer={selectedReferenceLayer} />
      ) : (
        <p className="arcgis-layer-details__empty-table">请选择一个图层查看字段和属性。</p>
      )}
    </div>
  )
}


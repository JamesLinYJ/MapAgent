// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层管理共享组件
//
//   文件:       LayerManagerShared.tsx
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 承载图层管理 7 个视图共享的树节点、详情面板、字段 chips 和属性预览。
// 这些组件只展示 useLayerManager 产出的 view model，不直接修改地图或后端状态。

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  LocateFixed,
  Palette,
  Trash2,
} from 'lucide-react'

import type { LayerDescriptor } from '@geo-agent-platform/shared-types'

import type { LayerTreeNode } from './useLayerManager'
import { formatCell, formatLayerBounds, formatLayerKind } from './layerManagerFormatters'

interface LayerNodeViewProps {
  node: LayerTreeNode
  depth: number
  selectedId: string | null
  onSelectLayer: (id: string | null) => void
  onToggleVisibility: (id: string) => void
  onToggleGroup: (id: string) => void
  onMoveLayer?: (id: string, targetId: string) => void
  onMoveUp?: (id: string) => void
  onMoveDown?: (id: string) => void
  onZoomToLayer?: (id: string) => void
  onRemoveLayer?: (id: string) => void
}

export function LayerNodeView({
  node,
  depth,
  selectedId,
  onSelectLayer,
  onToggleVisibility,
  onToggleGroup,
  onMoveLayer,
  onMoveUp,
  onMoveDown,
  onZoomToLayer,
  onRemoveLayer,
}: LayerNodeViewProps) {
  const isGroup = node.type === 'group'
  const [contextMenu, setContextMenu] = useState<{ left: number; top: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const style = !isGroup
    ? { '--layer-color': node.color ?? '#2563eb' } as CSSProperties
    : undefined

  useEffect(() => {
    if (!contextMenu) return
    const dismiss = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return
      setContextMenu(null)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', dismissOnEscape)
    contextMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [contextMenu])

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
  ) => {
    event.preventDefault()
    onSelectLayer(node.id)
    if (isGroup) return
    if ('clientX' in event && (event.clientX || event.clientY)) {
      setContextMenu({
        left: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
        top: Math.max(8, Math.min(event.clientY, window.innerHeight - 250)),
      })
      return
    }
    const bounds = event.currentTarget.getBoundingClientRect()
    setContextMenu({ left: bounds.left + 24, top: bounds.bottom })
  }

  const handleLayerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (isGroup) return
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      openContextMenu(event)
      return
    }
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault()
      onMoveUp?.(node.id)
    } else if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault()
      onMoveDown?.(node.id)
    } else if (event.key === 'Delete') {
      event.preventDefault()
      onRemoveLayer?.(node.id)
    }
  }

  return (
    <div
      className={`arcgis-layer-node-wrap${node.id === selectedId ? ' is-selected' : ''}`}
      role="treeitem"
      aria-selected={node.id === selectedId}
      aria-expanded={isGroup ? Boolean(node.expanded) : undefined}
      style={{ marginLeft: depth * 14 }}
      draggable={!isGroup && Boolean(onMoveLayer)}
      onDragStart={event => {
        if (isGroup || !onMoveLayer) {
          event.preventDefault()
          return
        }
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-geo-agent-platform-layer-id', node.id)
        event.dataTransfer.setData('text/plain', node.id)
      }}
      onDragOver={event => {
        if (isGroup || !onMoveLayer) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={event => {
        if (isGroup || !onMoveLayer) return
        event.preventDefault()
        const sourceId = event.dataTransfer.getData('application/x-geo-agent-platform-layer-id')
          || event.dataTransfer.getData('text/plain')
        if (sourceId && sourceId !== node.id) onMoveLayer(sourceId, node.id)
      }}
      onContextMenu={openContextMenu}
    >
      <div className="arcgis-layer-node">
        <button
          type="button"
          className="arcgis-layer-node__twisty"
          onClick={() => isGroup ? onToggleGroup(node.id) : onSelectLayer(node.id)}
          aria-label={isGroup ? '展开或折叠分组' : '选择图层'}
        >
          {isGroup ? (node.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span />}
        </button>
        <input
          className="arcgis-layer-node__checkbox"
          type="checkbox"
          checked={node.visible}
          onChange={() => onToggleVisibility(node.id)}
          aria-label={`${node.visible ? '隐藏' : '显示'}${node.name}`}
        />
        <button
          type="button"
          className="arcgis-layer-node__label"
          onClick={() => onSelectLayer(node.id)}
          onDoubleClick={() => {
            if (!isGroup) onZoomToLayer?.(node.id)
          }}
          onKeyDown={handleLayerKeyDown}
          aria-haspopup={isGroup ? undefined : 'menu'}
          title={isGroup ? node.name : `${node.name}（双击定位，Shift+F10 打开菜单）`}
        >
          <span className={isGroup ? 'arcgis-layer-node__folder' : 'arcgis-layer-node__symbol'} style={style}>
            {isGroup ? null : <Palette size={12} />}
          </span>
          <strong>{node.name}</strong>
        </button>
      </div>
      {!isGroup ? <LayerLegend node={node} /> : null}

      {isGroup && node.expanded && node.children?.length ? (
        <div role="group">
          {node.children.map(child => (
            <LayerNodeView
              key={child.id}
              node={child}
              depth={depth + 1}
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
          ))}
        </div>
      ) : null}
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="arcgis-layer-context-menu"
          role="menu"
          aria-label={`${node.name} 图层操作`}
          style={{ left: contextMenu.left, top: contextMenu.top }}
        >
          <LayerContextAction
            icon={<LocateFixed size={14} />}
            label="定位到图层"
            onClick={() => {
              onZoomToLayer?.(node.id)
              setContextMenu(null)
            }}
          />
          <LayerContextAction
            icon={node.visible ? <EyeOff size={14} /> : <Eye size={14} />}
            label={node.visible ? '隐藏图层' : '显示图层'}
            onClick={() => {
              onToggleVisibility(node.id)
              setContextMenu(null)
            }}
          />
          <span className="arcgis-layer-context-menu__separator" role="separator" />
          <LayerContextAction
            icon={<ArrowUp size={14} />}
            label="上移一层"
            shortcut="Alt+↑"
            onClick={() => {
              onMoveUp?.(node.id)
              setContextMenu(null)
            }}
          />
          <LayerContextAction
            icon={<ArrowDown size={14} />}
            label="下移一层"
            shortcut="Alt+↓"
            onClick={() => {
              onMoveDown?.(node.id)
              setContextMenu(null)
            }}
          />
          <LayerContextAction
            danger
            icon={<Trash2 size={14} />}
            label="移除图层…"
            shortcut="Delete"
            onClick={() => {
              onRemoveLayer?.(node.id)
              setContextMenu(null)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

function LayerContextAction({
  danger = false,
  icon,
  label,
  shortcut,
  onClick,
}: {
  danger?: boolean
  icon: ReactNode
  label: string
  shortcut?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? 'is-danger' : undefined}
      onClick={() => {
        onClick()
      }}
    >
      {icon}
      <span>{label}</span>
      {shortcut ? <kbd>{shortcut}</kbd> : null}
    </button>
  )
}

function LayerLegend({ node }: { node: LayerTreeNode }) {
  if (node.layerKind === 'raster' || /\.(tif|tiff|png|jpg|jpeg)$/i.test(node.name)) {
    return <RasterLayerLegend node={node} />
  }

  return (
    <div className="arcgis-layer-legend">
      <span>
        <i style={{ background: node.color ?? '#f5b5cf' }} />
        <b>{node.featureCount ?? 0} 对象 · {node.geometrySummary ?? '地图图层'}</b>
      </span>
    </div>
  )
}

function RasterLayerLegend({ node }: { node: LayerTreeNode }) {
  const legend = node.legend
  if (!legend) {
    return (
      <div className="arcgis-layer-legend arcgis-layer-legend--raster">
        <strong>{node.geometrySummary ?? '栅格图层'}</strong>
        <span><b>当前图层未配置数值图例</b></span>
      </div>
    )
  }

  if (legend.kind === 'continuous') {
    const gradient = `linear-gradient(90deg, ${legend.stops
      .map(stop => `${stop.color} ${continuousStopPercent(stop.value, legend.range)}%`)
      .join(', ')})`
    return (
      <div className="arcgis-layer-legend arcgis-layer-legend--raster">
        <strong>{legend.title}{legend.unit ? `（${legend.unit}）` : ''}</strong>
        <span className="arcgis-layer-legend__continuous">
          <i style={{ background: gradient }} />
          <b>{formatLegendNumber(legend.range[0])} – {formatLegendNumber(legend.range[1])}{legend.unit ? ` ${legend.unit}` : ''}</b>
        </span>
      </div>
    )
  }

  const entries = legend.kind === 'classified'
    ? legend.classes.map(item => ({
        key: `${item.min}:${item.max}:${item.label}`,
        label: item.label,
        value: `${formatLegendNumber(item.min)} – ${formatLegendNumber(item.max)}${legend.unit ? ` ${legend.unit}` : ''}`,
        color: item.color,
      }))
    : legend.categories.map(item => ({
        key: String(item.value),
        label: item.label,
        value: String(item.value),
        color: item.color,
      }))
  return (
    <div className="arcgis-layer-legend arcgis-layer-legend--raster">
      <strong>{legend.title}{legend.kind === 'classified' && legend.unit ? `（${legend.unit}）` : ''}</strong>
      {entries.map(entry => (
        <span key={entry.key}>
          <i style={{ background: entry.color }} />
          <em>{entry.label}：</em>
          <b>{entry.value}</b>
        </span>
      ))}
    </div>
  )
}

function continuousStopPercent(value: number, range: [number, number]): number {
  const [minimum, maximum] = range
  if (maximum <= minimum) return 0
  return Math.max(0, Math.min(100, ((value - minimum) / (maximum - minimum)) * 100))
}

function formatLegendNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
}

export function LayerDetails({ node, compact = false }: { node: LayerTreeNode; compact?: boolean }) {
  const fields = useMemo(() => node.fieldNames ?? [], [node.fieldNames])
  const rows = useMemo(() => node.attributeRows ?? [], [node.attributeRows])
  const columns = useMemo(() => {
    const names = new Set<string>()
    if (rows.length) names.add('OBJECTID')
    fields.forEach(field => names.add(field))
    rows.forEach(row => Object.keys(row).forEach(key => names.add(key)))
    return [...names].slice(0, 10)
  }, [fields, rows])

  return (
    <div className={compact ? 'arcgis-layer-details arcgis-layer-details--compact' : 'arcgis-layer-details'}>
      <header>
        <strong>图层属性</strong>
        <span>{formatLayerKind(node)} · {node.artifactType ?? 'artifact'}</span>
      </header>

      <dl className="arcgis-layer-details__grid">
        <div><dt>图层名称</dt><dd>{node.name}</dd></div>
        <div><dt>数据类型</dt><dd>{formatLayerKind(node)}</dd></div>
        <div><dt>对象数量</dt><dd>{node.layerKind === 'raster' ? '1 张栅格' : `${node.featureCount ?? 0} 个要素`}</dd></div>
        <div><dt>空间摘要</dt><dd>{node.geometrySummary ?? '暂无空间摘要'}</dd></div>
        <div className="arcgis-layer-details__wide"><dt>数据来源</dt><dd>{node.sourceUri ?? '当前运行 artifact'}</dd></div>
      </dl>

      {node.metadataRows?.length ? <MetadataRows rows={node.metadataRows} /> : null}
      {fields.length ? <FieldChips fields={fields} /> : null}
      <AttributePreview rows={rows} columns={columns} emptyLabel={node.layerKind === 'raster' ? '栅格图层没有要素属性表，详情以元数据和栅格统计为准。' : '当前图层没有可预览的属性记录。'} />
    </div>
  )
}

export function ReferenceLayerDetails({ layer }: { layer: LayerDescriptor }) {
  return (
    <>
      <dl className="arcgis-layer-details__grid">
        <div><dt>图层名称</dt><dd>{layer.name}</dd></div>
        <div><dt>状态</dt><dd>{layer.status === 'active' ? '已启用' : '已停用'}</dd></div>
        <div><dt>几何类型</dt><dd>{layer.geometryType}</dd></div>
        <div><dt>对象数量</dt><dd>{layer.featureCount ?? 0} 个要素</dd></div>
        <div><dt>坐标系</dt><dd>SRID {layer.srid}</dd></div>
        <div><dt>范围</dt><dd>{formatLayerBounds(layer.bounds)}</dd></div>
        <div className="arcgis-layer-details__wide"><dt>描述</dt><dd>{layer.description || '暂无描述'}</dd></div>
      </dl>
      {layer.tags.length ? <FieldChips title="标签" fields={layer.tags} /> : null}
      {layer.analysisCapabilities.length ? <FieldChips title="分析能力" fields={layer.analysisCapabilities} /> : null}
      {layer.propertySchema.length ? (
        <section className="arcgis-layer-details__metadata" aria-label="字段">
          <h4>字段</h4>
          <dl>
            {layer.propertySchema.slice(0, 16).map(field => (
              <div key={field.name}>
                <dt>{field.name}</dt>
                <dd>{field.dataType} · {field.populatedCount} 条 · {field.sampleValues.slice(0, 3).join('、') || '无样例'}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </>
  )
}

function MetadataRows({ rows }: { rows: Array<{ key: string; value: string }> }) {
  return (
    <section className="arcgis-layer-details__metadata" aria-label="图层元数据">
      <h4>详细元数据</h4>
      <dl>
        {rows.map(row => (
          <div key={row.key}>
            <dt>{row.key}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function FieldChips({ fields, title = '字段' }: { fields: string[]; title?: string }) {
  return (
    <section className="arcgis-layer-details__fields" aria-label={title}>
      <h4>{title}</h4>
      <div>{fields.map(field => <span key={field}>{field}</span>)}</div>
    </section>
  )
}

function AttributePreview({ rows, columns, emptyLabel }: { rows: Array<Record<string, unknown>>; columns: string[]; emptyLabel: string }) {
  if (!rows.length || !columns.length) {
    return <p className="arcgis-layer-details__empty-table">{emptyLabel}</p>
  }
  return (
    <section className="arcgis-layer-details__table" aria-label="属性表预览">
      <h4>属性表预览</h4>
      <div className="arcgis-layer-table-scroll">
        <table>
          <thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={String(row.OBJECTID ?? index)}>
                {columns.map(column => <td key={column}>{formatCell(row[column])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

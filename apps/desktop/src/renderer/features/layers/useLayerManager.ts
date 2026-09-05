// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层管理视图状态
//
//   文件:       useLayerManager.ts
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LayerDescriptor, MapLegend, MapLayerStyle, MapSceneLayer } from '@geo-agent-platform/shared-types'
import {
  PLATFORM_RENDERER_EVENT_PREFIX,
} from '@geo-agent-platform/shared-types/product-identity'
import type { SceneRenderLayer } from '../map/useMapScene'
import { isRecord } from '../../shared/utils/guards'

export type LayerPanelView = 'drawOrder' | 'sources' | 'selection' | 'style' | 'add' | 'labels' | 'table'
export type LayerVisibilityFilter = 'all' | 'visible' | 'hidden'

export interface LayerTreeNode {
  id: string
  name: string
  type: 'group' | 'layer'
  layerKind?: 'geojson' | 'raster'
  artifactType?: string
  sourceUri?: string
  visible: boolean
  opacity: number
  color?: string
  fieldNames?: string[]
  attributeRows?: Array<Record<string, unknown>>
  metadataRows?: Array<{ key: string; value: string }>
  artifactId?: string
  managedLayerKey?: string
  featureCount?: number
  geometrySummary?: string
  legend?: MapLegend | null
  children?: LayerTreeNode[]
  expanded?: boolean
  labelEnabled?: boolean
  labelField?: string
}

export interface LayerOverride {
  name?: string
}

interface LayerGroup {
  id: string
  name: string
  memberIds: string[]
  expanded: boolean
}

export interface LayerManagerPreferences {
  activeView: LayerPanelView
  visibilityFilter: LayerVisibilityFilter
  groups: LayerGroup[]
  overrides: Record<string, LayerOverride>
}

interface UseLayerManagerOptions {
  layers: SceneRenderLayer[]
  referenceLayers: LayerDescriptor[]
  onReplaceLayers: (layers: MapSceneLayer[]) => Promise<void>
  onAddLayer: (mapLayerId: string) => Promise<void>
  preferenceKey?: string
}

const DEFAULT_LAYER_MANAGER_PREFERENCES: LayerManagerPreferences = {
  activeView: 'drawOrder',
  visibilityFilter: 'all',
  groups: [],
  overrides: {},
}

/** 图层面板直接编辑 MapScene；localStorage 只保存分组、面板视图和显示名称。 */
export function useLayerManager({ layers, referenceLayers, onReplaceLayers, onAddLayer, preferenceKey }: UseLayerManagerOptions) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [operationError, setOperationError] = useState<string | null>(null)
  const [preferenceState, setPreferenceState] = useState(() => ({
    key: preferenceKey,
    value: readLayerManagerPreferences(preferenceKey),
  }))

  const preferences = useMemo(
    () => preferenceState.key === preferenceKey
      ? preferenceState.value
      : readLayerManagerPreferences(preferenceKey),
    [preferenceKey, preferenceState],
  )
  useEffect(() => {
    if (preferenceState.key === preferenceKey) {
      writeLayerManagerPreferences(preferenceKey, preferenceState.value)
    }
  }, [preferenceKey, preferenceState])

  const { activeView, groups, overrides, visibilityFilter } = preferences
  const orderedLayers = useMemo(
    () => layers.slice().sort((left, right) => left.scene.order - right.scene.order),
    [layers],
  )
  const layerIds = useMemo(() => orderedLayers.map(layer => layer.manifest.mapLayerId), [orderedLayers])
  const referenceByKey = useMemo(
    () => new Map(referenceLayers.map(layer => [layer.layerKey, layer])),
    [referenceLayers],
  )
  const sceneManagedLayerKeys = useMemo(
    () => orderedLayers.flatMap(layer => layer.manifest.managedLayerKey ? [layer.manifest.managedLayerKey] : []),
    [orderedLayers],
  )

  const filteredLayers = useMemo(() => {
    const normalized = searchQuery.trim().toLocaleLowerCase()
    return orderedLayers.filter(layer => {
      if (visibilityFilter === 'visible' && !layer.scene.visible) return false
      if (visibilityFilter === 'hidden' && layer.scene.visible) return false
      if (!normalized) return true
      const reference = layer.manifest.managedLayerKey ? referenceByKey.get(layer.manifest.managedLayerKey) : undefined
      return [
        overrides[layer.manifest.mapLayerId]?.name ?? layer.manifest.title,
        layer.manifest.source.kind,
        layer.manifest.style.kind,
        reference?.geometryType,
        reference?.description,
      ].some(value => value?.toLocaleLowerCase().includes(normalized))
    })
  }, [orderedLayers, overrides, referenceByKey, searchQuery, visibilityFilter])

  const tree = useMemo<LayerTreeNode[]>(() => {
    const layerNodes = filteredLayers.map(layer => toLayerTreeNode(
      layer,
      overrides[layer.manifest.mapLayerId],
      layer.manifest.managedLayerKey ? referenceByKey.get(layer.manifest.managedLayerKey) : undefined,
    ))
    if (!groups.length) return layerNodes

    const groupedIds = new Set(groups.flatMap(group => group.memberIds))
    const groupedNodes = groups.flatMap(group => {
      const knownMembers = group.memberIds.filter(id => layerIds.includes(id))
      if (!knownMembers.length) return []
      return [{
        id: group.id,
        name: group.name,
        type: 'group' as const,
        visible: knownMembers.some(id => layerNodes.find(node => node.id === id)?.visible),
        opacity: 1,
        expanded: group.expanded,
        children: group.expanded ? layerNodes.filter(node => knownMembers.includes(node.id)) : [],
      }]
    })
    return [...groupedNodes, ...layerNodes.filter(node => !groupedIds.has(node.id))]
  }, [filteredLayers, groups, layerIds, overrides, referenceByKey])

  const flatNodes = useMemo(() => flattenTree(tree), [tree])
  const selectedNode = useMemo(() => flatNodes.find(node => node.id === selectedId), [flatNodes, selectedId])

  const updatePreferences = useCallback((updater: (current: LayerManagerPreferences) => LayerManagerPreferences) => {
    setPreferenceState(current => {
      const value = current.key === preferenceKey
        ? current.value
        : readLayerManagerPreferences(preferenceKey)
      return {
        key: preferenceKey,
        value: sanitizeLayerManagerPreferences(updater(value)),
      }
    })
  }, [preferenceKey])

  const commit = useCallback((next: MapSceneLayer[]) => {
    setOperationError(null)
    const normalized = next.map((layer, order) => ({ ...layer, order }))
    void onReplaceLayers(normalized).catch(error => {
      setOperationError(error instanceof Error ? error.message : '地图场景更新失败。')
    })
  }, [onReplaceLayers])

  const patchLayers = useCallback((ids: Set<string>, patch: Partial<MapSceneLayer>) => {
    commit(orderedLayers.map(layer => ids.has(layer.manifest.mapLayerId)
      ? { ...layer.scene, ...patch }
      : layer.scene))
  }, [commit, orderedLayers])

  const selectLayer = useCallback((id: string | null) => setSelectedId(id), [])
  const setActiveView = useCallback((view: LayerPanelView) => updatePreferences(current => ({ ...current, activeView: view })), [updatePreferences])
  const setVisibilityFilter = useCallback((filter: LayerVisibilityFilter) => updatePreferences(current => ({ ...current, visibilityFilter: filter })), [updatePreferences])

  const toggleVisibility = useCallback((id: string) => {
    const group = groups.find(item => item.id === id)
    if (group) {
      const members = new Set(group.memberIds.filter(memberId => layerIds.includes(memberId)))
      const nextVisible = !orderedLayers.filter(layer => members.has(layer.manifest.mapLayerId)).every(layer => layer.scene.visible)
      patchLayers(members, { visible: nextVisible })
      return
    }
    const layer = orderedLayers.find(item => item.manifest.mapLayerId === id)
    if (layer) patchLayers(new Set([id]), { visible: !layer.scene.visible })
  }, [groups, layerIds, orderedLayers, patchLayers])

  const toggleAllVisibility = useCallback(() => {
    if (!filteredLayers.length) return
    const ids = new Set(filteredLayers.map(layer => layer.manifest.mapLayerId))
    patchLayers(ids, { visible: !filteredLayers.every(layer => layer.scene.visible) })
  }, [filteredLayers, patchLayers])

  const setOpacity = useCallback((id: string, opacity: number) => {
    const group = groups.find(item => item.id === id)
    const ids = new Set(group ? group.memberIds : [id])
    patchLayers(ids, { opacity: Math.max(0, Math.min(1, opacity)) })
  }, [groups, patchLayers])

  const setColor = useCallback((id: string, color: string) => {
    const layer = orderedLayers.find(item => item.manifest.mapLayerId === id)
    if (!layer) return
    const style = layer.scene.styleOverride ?? layer.manifest.style
    if (!supportsSingleColor(style)) {
      setOperationError('当前图层使用分级或栅格色带，不能用单一颜色覆盖。')
      return
    }
    patchLayers(new Set([id]), { styleOverride: { ...style, color } })
  }, [orderedLayers, patchLayers])

  const renameLayer = useCallback((id: string, name: string) => {
    updatePreferences(current => ({
      ...current,
      groups: current.groups.map(group => group.id === id ? { ...group, name } : group),
      overrides: layerIds.includes(id)
        ? { ...current.overrides, [id]: { name } }
        : current.overrides,
    }))
  }, [layerIds, updatePreferences])

  const moveBy = useCallback((id: string, delta: number) => {
    const index = orderedLayers.findIndex(layer => layer.manifest.mapLayerId === id)
    if (index < 0) return
    const nextIndex = Math.max(0, Math.min(orderedLayers.length - 1, index + delta))
    if (index === nextIndex) return
    const next = orderedLayers.map(layer => layer.scene)
    const [item] = next.splice(index, 1)
    if (!item) return
    next.splice(nextIndex, 0, item)
    commit(next)
  }, [commit, orderedLayers])

  const moveTo = useCallback((id: string, targetId: string) => {
    const scenes = reorderMapSceneLayers(
      orderedLayers.map(layer => layer.scene),
      id,
      targetId,
    )
    if (scenes) commit(scenes)
  }, [commit, orderedLayers])

  const removeLayer = useCallback((id: string) => {
    if (!layerIds.includes(id)) return
    commit(orderedLayers.filter(layer => layer.manifest.mapLayerId !== id).map(layer => layer.scene))
    setSelectedId(current => current === id ? null : current)
  }, [commit, layerIds, orderedLayers])

  const addReferenceLayer = useCallback(async (layerKey: string) => {
    setOperationError(null)
    const reference = referenceByKey.get(layerKey)
    if (!reference) {
      setOperationError(`数据源 '${layerKey}' 不存在。`)
      return
    }
    if (reference.status !== 'active') {
      setOperationError(`数据源 '${reference.name}' 已停用，不能加入地图。`)
      return
    }
    if (orderedLayers.some(layer => layer.manifest.mapLayerId === reference.mapLayerId)) return
    try {
      await onAddLayer(reference.mapLayerId)
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : '数据源加入地图失败。')
    }
  }, [onAddLayer, orderedLayers, referenceByKey])

  const removeReferenceLayer = useCallback((layerKey: string) => {
    const layer = orderedLayers.find(candidate => candidate.manifest.managedLayerKey === layerKey)
    if (layer) removeLayer(layer.manifest.mapLayerId)
  }, [orderedLayers, removeLayer])

  const createGroup = useCallback((name: string, memberIds: string[]) => {
    const cleanMemberIds = memberIds.filter(id => layerIds.includes(id))
    if (!name.trim() || !cleanMemberIds.length) return
    updatePreferences(current => ({
      ...current,
      groups: [...current.groups, {
        id: `group_${crypto.randomUUID().replaceAll('-', '')}`,
        name: name.trim(),
        memberIds: cleanMemberIds,
        expanded: true,
      }],
    }))
  }, [layerIds, updatePreferences])

  const toggleGroup = useCallback((id: string) => updatePreferences(current => ({
    ...current,
    groups: current.groups.map(group => group.id === id ? { ...group, expanded: !group.expanded } : group),
  })), [updatePreferences])

  const setLabelEnabled = useCallback((id: string, enabled: boolean) => {
    const node = flatNodes.find(item => item.id === id)
    const layer = orderedLayers.find(item => item.manifest.mapLayerId === id)
    if (!layer) return
    if (!enabled) {
      patchLayers(new Set([id]), { label: null })
      return
    }
    const field = layer.scene.label?.field ?? node?.labelField ?? node?.fieldNames?.[0]
    if (!field) {
      setOperationError('当前图层没有可用于标注的属性字段。')
      return
    }
    patchLayers(new Set([id]), {
      label: layer.scene.label ?? {
        field,
        placement: 'auto',
        size: 12,
        color: '#1f2937',
        haloColor: '#ffffff',
        haloWidth: 1.5,
      },
    })
  }, [flatNodes, orderedLayers, patchLayers])

  const setLabelField = useCallback((id: string, field: string) => {
    const layer = orderedLayers.find(item => item.manifest.mapLayerId === id)
    const node = flatNodes.find(item => item.id === id)
    if (!layer || !node?.fieldNames?.includes(field)) {
      setOperationError('所选标注字段不属于当前图层。')
      return
    }
    patchLayers(new Set([id]), {
      label: {
        field,
        placement: layer.scene.label?.placement ?? 'auto',
        size: layer.scene.label?.size ?? 12,
        color: layer.scene.label?.color ?? '#1f2937',
        haloColor: layer.scene.label?.haloColor ?? '#ffffff',
        haloWidth: layer.scene.label?.haloWidth ?? 1.5,
      },
    })
  }, [flatNodes, orderedLayers, patchLayers])

  return {
    tree,
    selectedId,
    searchQuery,
    totalCount: orderedLayers.length,
    visibleCount: orderedLayers.filter(layer => layer.scene.visible).length,
    selectedNode,
    activeView,
    visibilityFilter,
    sceneManagedLayerKeys,
    preferences,
    operationError,
    selectLayer,
    toggleVisibility,
    toggleAllVisibility,
    setOpacity,
    setColor,
    renameLayer,
    moveUp: (id: string) => moveBy(id, -1),
    moveDown: (id: string) => moveBy(id, 1),
    moveTo,
    removeLayer,
    addReferenceLayer,
    removeReferenceLayer,
    createGroup,
    toggleGroup,
    setSearchQuery,
    setActiveView,
    setVisibilityFilter,
    setLabelEnabled,
    setLabelField,
  }
}

export function reorderMapSceneLayers(
  layers: readonly MapSceneLayer[],
  sourceId: string,
  targetId: string,
): MapSceneLayer[] | null {
  if (sourceId === targetId) return null
  const ordered = [...layers].sort((left, right) => left.order - right.order)
  const sourceIndex = ordered.findIndex(layer => layer.mapLayerId === sourceId)
  const targetIndex = ordered.findIndex(layer => layer.mapLayerId === targetId)
  if (sourceIndex < 0 || targetIndex < 0) return null
  const [source] = ordered.splice(sourceIndex, 1)
  if (!source) return null
  const insertionIndex = ordered.findIndex(layer => layer.mapLayerId === targetId)
  if (insertionIndex < 0) return null
  ordered.splice(insertionIndex, 0, source)
  return ordered.map((layer, order) => ({ ...layer, order }))
}

function toLayerTreeNode(
  layer: SceneRenderLayer,
  override: LayerOverride | undefined,
  reference: LayerDescriptor | undefined,
): LayerTreeNode {
  const { manifest, scene } = layer
  const layerKind = isRasterStyle(manifest.style.kind) ? 'raster' : 'geojson'
  const fieldNames = manifest.capabilities.labels ? reference?.propertySchema.map(field => field.name) ?? [] : []
  return {
    id: manifest.mapLayerId,
    name: override?.name ?? manifest.title,
    type: 'layer',
    layerKind,
    artifactType: manifest.source.kind,
    sourceUri: sourceUri(manifest.source),
    visible: scene.visible,
    opacity: scene.opacity,
    color: styleColor(scene.styleOverride ?? manifest.style),
    fieldNames,
    attributeRows: [],
    metadataRows: [
      { key: '地图图层标识', value: manifest.mapLayerId },
      { key: '所有权', value: manifest.ownershipScope },
      { key: '坐标系', value: manifest.crs },
      { key: '数据版本', value: String(manifest.dataVersion) },
      { key: '状态', value: manifest.status },
    ],
    artifactId: manifest.artifactId ?? undefined,
    managedLayerKey: manifest.managedLayerKey ?? undefined,
    featureCount: reference?.featureCount ?? (manifest.source.kind === 'geojson' ? manifest.source.featureCount : undefined),
    geometrySummary: reference?.geometryType ?? manifest.style.kind,
    legend: manifest.legend,
    labelEnabled: Boolean(scene.label),
    labelField: scene.label?.field && fieldNames.includes(scene.label.field) ? scene.label.field : fieldNames[0],
  }
}

function isRasterStyle(kind: MapLayerStyle['kind']): boolean {
  return kind === 'continuous_raster' || kind === 'categorical_raster' || kind === 'hillshade'
}

function styleColor(style: MapLayerStyle): string | undefined {
  return 'color' in style && typeof style.color === 'string' ? style.color : undefined
}

function supportsSingleColor(style: MapLayerStyle): style is Extract<MapLayerStyle, { color: string }> {
  return 'color' in style && typeof style.color === 'string'
}

function sourceUri(source: SceneRenderLayer['manifest']['source']): string {
  return 'url' in source ? source.url : source.tileJsonUrl
}

function flattenTree(nodes: LayerTreeNode[]): LayerTreeNode[] {
  return nodes.flatMap(node => [node, ...(node.children ? flattenTree(node.children) : [])])
}

export function readLayerManagerPreferences(preferenceKey?: string): LayerManagerPreferences {
  if (!preferenceKey || typeof window === 'undefined') return DEFAULT_LAYER_MANAGER_PREFERENCES
  try {
    const raw = window.localStorage.getItem(storageKey(preferenceKey))
    return raw ? sanitizeLayerManagerPreferences(JSON.parse(raw)) : DEFAULT_LAYER_MANAGER_PREFERENCES
  } catch {
    return DEFAULT_LAYER_MANAGER_PREFERENCES
  }
}

export function writeLayerManagerPreferences(preferenceKey: string | undefined, preferences: LayerManagerPreferences) {
  if (!preferenceKey || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey(preferenceKey), JSON.stringify(sanitizeLayerManagerPreferences(preferences)))
  } catch {
    // 浏览器禁用持久化时，当前 React 状态仍然可用；地图事实仍保存在服务端 MapScene。
  }
}

export function sanitizeLayerManagerPreferences(value: unknown): LayerManagerPreferences {
  if (!isRecord(value)) return DEFAULT_LAYER_MANAGER_PREFERENCES
  return {
    activeView: isLayerPanelView(value.activeView) ? value.activeView : 'drawOrder',
    visibilityFilter: isVisibilityFilter(value.visibilityFilter) ? value.visibilityFilter : 'all',
    groups: Array.isArray(value.groups) ? value.groups.flatMap(readLayerGroup) : [],
    overrides: readRecord(value.overrides, readLayerOverride),
  }
}

function readLayerGroup(value: unknown): LayerGroup[] {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || !Array.isArray(value.memberIds)) return []
  return [{ id: value.id, name: value.name, memberIds: value.memberIds.map(String), expanded: value.expanded !== false }]
}

function readLayerOverride(value: unknown): LayerOverride | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.name === 'string' ? { name: value.name } : undefined
}

function readRecord<T>(value: unknown, reader: (entry: unknown) => T | undefined): Record<string, T> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const parsed = reader(entry)
    return parsed === undefined ? [] : [[key, parsed]]
  }))
}

function isLayerPanelView(value: unknown): value is LayerPanelView {
  return ['drawOrder', 'sources', 'selection', 'style', 'add', 'labels', 'table'].includes(String(value))
}

function isVisibilityFilter(value: unknown): value is LayerVisibilityFilter {
  return ['all', 'visible', 'hidden'].includes(String(value))
}

function storageKey(preferenceKey: string): string {
  return `${PLATFORM_RENDERER_EVENT_PREFIX}:layer-manager:${preferenceKey}`
}

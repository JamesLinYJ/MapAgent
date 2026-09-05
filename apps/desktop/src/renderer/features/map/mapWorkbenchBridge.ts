// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图工作台命令与状态桥
//
//   文件:       mapWorkbenchBridge.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  PLATFORM_RENDERER_EVENT_PREFIX,
} from '@geo-agent-platform/shared-types/product-identity'

export type MapWorkbenchCommand =
  | 'zoom-in'
  | 'zoom-out'
  | 'toggle-measure'
  | 'focus-selection'

export interface MapWorkbenchStatus {
  ready: boolean
  longitude: number | null
  latitude: number | null
  zoom: number | null
  scaleDenominator: number | null
  crs: 'EPSG:3857' | null
  selectedFeatureCount: number
}

const COMMAND_EVENT = `${PLATFORM_RENDERER_EVENT_PREFIX}:map-command`
const STATUS_EVENT = `${PLATFORM_RENDERER_EVENT_PREFIX}:map-status`

export const INITIAL_MAP_WORKBENCH_STATUS: MapWorkbenchStatus = {
  ready: false,
  longitude: null,
  latitude: null,
  zoom: null,
  scaleDenominator: null,
  crs: null,
  selectedFeatureCount: 0,
}

export function requestMapWorkbenchCommand(command: MapWorkbenchCommand): void {
  window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: command }))
}

export function subscribeMapWorkbenchCommand(
  listener: (command: MapWorkbenchCommand) => void,
): () => void {
  const commands = new Set<MapWorkbenchCommand>([
    'zoom-in',
    'zoom-out',
    'toggle-measure',
    'focus-selection',
  ])
  const handleEvent = (event: Event) => {
    if (!(event instanceof CustomEvent) || !commands.has(event.detail)) return
    listener(event.detail)
  }
  window.addEventListener(COMMAND_EVENT, handleEvent)
  return () => window.removeEventListener(COMMAND_EVENT, handleEvent)
}

export function publishMapWorkbenchStatus(status: MapWorkbenchStatus): void {
  window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: status }))
}

export function subscribeMapWorkbenchStatus(
  listener: (status: MapWorkbenchStatus) => void,
): () => void {
  const handleEvent = (event: Event) => {
    if (!(event instanceof CustomEvent) || !isMapWorkbenchStatus(event.detail)) return
    listener(event.detail)
  }
  window.addEventListener(STATUS_EVENT, handleEvent)
  return () => window.removeEventListener(STATUS_EVENT, handleEvent)
}

export function scaleDenominatorForWebMercator(zoom: number, latitude: number): number {
  if (!Number.isFinite(zoom) || !Number.isFinite(latitude)) return 0
  const clampedLatitude = Math.max(-85.051_129, Math.min(85.051_129, latitude))
  const earthCircumferenceMeters = 40_075_016.686
  const metersPerPixel = Math.cos(clampedLatitude * Math.PI / 180)
    * earthCircumferenceMeters
    / (512 * 2 ** zoom)
  return Math.max(1, Math.round(metersPerPixel / 0.000_28))
}

export function formatMapScale(scaleDenominator: number | null): string {
  if (!scaleDenominator || scaleDenominator < 1) return '比例尺 —'
  return `比例尺 1:${new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 0,
  }).format(scaleDenominator)}`
}

export function formatMapCoordinates(
  longitude: number | null,
  latitude: number | null,
): string {
  if (longitude === null || latitude === null) return '坐标 —'
  return `${Math.abs(longitude).toFixed(4)}° ${longitude >= 0 ? 'E' : 'W'}  `
    + `${Math.abs(latitude).toFixed(4)}° ${latitude >= 0 ? 'N' : 'S'}`
}

function isMapWorkbenchStatus(value: unknown): value is MapWorkbenchStatus {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<MapWorkbenchStatus>
  return typeof candidate.ready === 'boolean'
    && nullableFinite(candidate.longitude)
    && nullableFinite(candidate.latitude)
    && nullableFinite(candidate.zoom)
    && nullableFinite(candidate.scaleDenominator)
    && (candidate.crs === null || candidate.crs === 'EPSG:3857')
    && Number.isInteger(candidate.selectedFeatureCount)
    && (candidate.selectedFeatureCount ?? -1) >= 0
}

function nullableFinite(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

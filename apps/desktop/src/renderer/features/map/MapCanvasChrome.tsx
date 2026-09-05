// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图画布渲染外壳
//
//   文件:       MapCanvasChrome.tsx
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { useEffect, useMemo, useState, type RefObject } from 'react'
import { AnimatePresence, m } from 'framer-motion'
import { Camera, LoaderCircle, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import type { MapLegend } from '@geo-agent-platform/shared-types'
import { buildFadeMotion, buildFadeUpMotion } from '../../shared/motion'
import type { SceneRenderLayer } from './useMapScene'

interface MapCanvasChromeProps {
  containerRef: RefObject<HTMLDivElement | null>
  cursor: string
  layerErrors: Record<string, string>
  layers: SceneRenderLayer[]
  mapReady: boolean
  basemapRendered: boolean
  mapError: string | null
  measureMode: boolean
  measurementLabel: string
  reducedMotion: boolean
  resourceWarning: string | null
  sceneLoading: boolean
  selectedLayerId?: string
  selectedLayerName?: string
  captureBusy: boolean
  captureError: string | null
  onCapture: () => void
  onSetCurrentFrame: (mapLayerId: string, frameId: string) => Promise<void>
}

export function MapCanvasChrome({
  containerRef,
  cursor,
  layerErrors,
  layers,
  mapReady,
  basemapRendered,
  mapError,
  measureMode,
  measurementLabel,
  reducedMotion,
  resourceWarning,
  sceneLoading,
  selectedLayerId,
  selectedLayerName,
  captureBusy,
  captureError,
  onCapture,
  onSetCurrentFrame,
}: MapCanvasChromeProps) {
  const selectedLayer = layers.find(layer => layer.manifest.mapLayerId === selectedLayerId)
  const selectedError = selectedLayerId ? layerErrors[selectedLayerId] : undefined
  const legendLayer = selectedLayer?.scene.visible && selectedLayer.manifest.legend
    ? selectedLayer
    : layers.find(layer => layer.scene.visible && layer.manifest.legend)

  return (
    <m.section
      className="dc-map-stage dc-map-stage--scientific"
      aria-label="地图画布"
      data-map-ready={mapReady ? 'true' : 'false'}
      data-basemap-rendered={basemapRendered ? 'true' : 'false'}
      layout
      {...buildFadeUpMotion(reducedMotion, 0.06, 18)}
    >
      <div ref={containerRef} className="dc-map-stage__canvas" />
      <div className="dc-map-stage__wash" aria-hidden="true" />

      {mapError ? (
        <m.div className="dc-map-stage__blocking-error" role="alert" {...buildFadeUpMotion(reducedMotion, 0.08, 12)}>
          <strong>地图无法渲染</strong>
          <p>{mapError}</p>
        </m.div>
      ) : null}

      <AnimatePresence initial={false}>
        {resourceWarning ? (
          <m.div className="dc-map-stage__warning" role="status" {...buildFadeUpMotion(reducedMotion, 0.08, 8)}>
            {resourceWarning}
          </m.div>
        ) : null}
      </AnimatePresence>

      <m.div className="dc-map-stage__hud" layout {...buildFadeMotion(reducedMotion, 0.08)}>
        <div className="dc-map-stage__status-copy">
          <span>{selectedLayerName ?? (sceneLoading ? '正在读取地图场景' : '当前对话暂无地图结果')}</span>
          <small>{measureMode ? measurementLabel : selectedError ?? `${layers.length} 个图层 · ${cursor}`}</small>
        </div>
        <button
          type="button"
          className="dc-map-stage__capture"
          onClick={onCapture}
          disabled={!mapReady || captureBusy}
          aria-label="将当前地图截图附加到对话"
          title="附加当前地图截图"
        >
          {captureBusy ? <LoaderCircle className="cc-spin" size={16} /> : <Camera size={16} />}
          <span>{captureBusy ? '截图中' : '附加截图'}</span>
        </button>
      </m.div>

      {captureError ? <p className="dc-map-stage__capture-error" role="alert">{captureError}</p> : null}

      <AnimatePresence initial={false}>
        {legendLayer ? (
          <m.aside className="dc-map-stage__legend dc-map-stage__legend--scientific" aria-label="科学图例" {...buildFadeUpMotion(reducedMotion, 0.12, 10)}>
            <header>
              <strong>图例</strong>
              <span title={legendLayer.manifest.title}>{legendLayer.manifest.title}</span>
            </header>
            <div className="dc-map-stage__legend-content">
              {layerErrors[legendLayer.manifest.mapLayerId]
                ? <small className="is-error">{layerErrors[legendLayer.manifest.mapLayerId]}</small>
                : <ScientificLegend legend={legendLayer.manifest.legend} />}
            </div>
          </m.aside>
        ) : null}
      </AnimatePresence>

      {selectedLayer?.manifest.temporal ? (
        <TemporalControl
          layer={selectedLayer}
          reducedMotion={reducedMotion}
          onSetFrame={onSetCurrentFrame}
        />
      ) : null}
    </m.section>
  )
}

function ScientificLegend({ legend }: { legend: MapLegend | null }) {
  if (!legend) return <small>无分级图例</small>
  if (legend.kind === 'continuous') {
    const gradient = `linear-gradient(90deg, ${legend.stops.map(stop => `${stop.color} ${rangePercent(stop.value, legend.range)}%`).join(', ')})`
    return (
      <span className="dc-map-stage__continuous-legend">
        <i style={{ background: gradient }} aria-hidden="true" />
        <small><b>{formatNumber(legend.range[0])}</b><span>{legend.unit ?? ''}</span><b>{formatNumber(legend.range[1])}</b></small>
      </span>
    )
  }
  const entries = legend.kind === 'categorical'
    ? legend.categories.map(item => ({ label: item.label, color: item.color }))
    : legend.classes.map(item => ({ label: item.label, color: item.color }))
  return (
    <span className="dc-map-stage__category-legend">
      {entries.slice(0, 6).map(entry => <span key={`${entry.label}-${entry.color}`}><i style={{ background: entry.color }} />{entry.label}</span>)}
      {entries.length > 6 ? <small>另有 {entries.length - 6} 类</small> : null}
    </span>
  )
}

function TemporalControl({ layer, reducedMotion, onSetFrame }: {
  layer: SceneRenderLayer
  reducedMotion: boolean
  onSetFrame: (mapLayerId: string, frameId: string) => Promise<void>
}) {
  const frames = useMemo(
    () => layer.manifest.temporal?.frames ?? [],
    [layer.manifest.temporal?.frames],
  )
  const currentId = layer.scene.currentFrameId ?? layer.manifest.temporal?.defaultFrameId
  const currentIndex = Math.max(0, frames.findIndex(frame => frame.frameId === currentId))
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    if (!playing || reducedMotion || frames.length < 2) return
    let cancelled = false
    let timer: number | undefined
    const advance = async () => {
      const index = Math.max(0, frames.findIndex(frame => frame.frameId === (layer.scene.currentFrameId ?? currentId)))
      const next = frames[(index + 1) % frames.length]
      if (!next) return
      try {
        await onSetFrame(layer.manifest.mapLayerId, next.frameId)
      } catch {
        setPlaying(false)
        return
      }
      if (!cancelled) timer = window.setTimeout(() => { void advance() }, 900)
    }
    timer = window.setTimeout(() => { void advance() }, 900)
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [currentId, frames, layer.manifest.mapLayerId, layer.scene.currentFrameId, onSetFrame, playing, reducedMotion])

  const setIndex = (index: number) => {
    const frame = frames[Math.max(0, Math.min(frames.length - 1, index))]
    if (frame) void onSetFrame(layer.manifest.mapLayerId, frame.frameId)
  }
  return (
    <m.div className="dc-map-stage__timeline" {...buildFadeUpMotion(reducedMotion, 0.12, 8)}>
      <button type="button" onClick={() => setIndex(currentIndex - 1)} aria-label="上一时次"><SkipBack size={16} /></button>
      <button type="button" onClick={() => setPlaying(value => !value)} aria-label={playing ? '暂停时间动画' : '播放时间动画'} disabled={reducedMotion}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(0, frames.length - 1)}
        value={currentIndex}
        onChange={event => setIndex(Number(event.target.value))}
        aria-label="时间帧"
      />
      <span>{frames[currentIndex]?.label ?? '未知时次'}</span>
      <button type="button" onClick={() => setIndex(currentIndex + 1)} aria-label="下一时次"><SkipForward size={16} /></button>
    </m.div>
  )
}

function rangePercent(value: number, range: [number, number]): number {
  return Math.max(0, Math.min(100, ((value - range[0]) / (range[1] - range[0])) * 100))
}

function formatNumber(value: number): string {
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2).replace(/\.00$/u, '')
}

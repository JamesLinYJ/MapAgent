// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图瓦片数据源契约
//
//   文件:       mapTileSource.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { MapTileExecutionSpec } from '../store/postgres/mapStore.js'

export interface MapTileResponse {
  body: ArrayBuffer
  contentType: string
  cacheControl: string
  etag: string | null
}

export interface VectorTileSource {
  fetchTile(
    spec: MapTileExecutionSpec,
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<MapTileResponse>
}

export interface RasterTileSource {
  renderTile(
    spec: MapTileExecutionSpec,
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<MapTileResponse>
  close(): Promise<void>
}

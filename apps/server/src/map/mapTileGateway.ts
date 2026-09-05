// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图瓦片网关
//
//   文件:       mapTileGateway.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { MapTileExecutionSpec } from '../store/postgres/mapStore.js'
import type { MapTileResponse, RasterTileSource, VectorTileSource } from './mapTileSource.js'

export type { MapTileResponse } from './mapTileSource.js'

export class MapTileGateway {
  constructor(
    private readonly vectorTiles: VectorTileSource,
    private readonly rasterTiles: RasterTileSource,
  ) {}

  async fetchTile(spec: MapTileExecutionSpec, z: number, x: number, y: number, signal?: AbortSignal): Promise<MapTileResponse> {
    validateTileCoordinate(z, x, y)
    const source = spec.manifest.source
    if (source.kind === 'vector_tiles') {
      return this.vectorTiles.fetchTile(spec, z, x, y, signal)
    }
    if (source.kind === 'raster_tiles' || source.kind === 'raster_dem') {
      return this.rasterTiles.renderTile(spec, z, x, y, signal)
    }
    throw new Error(`图层 '${spec.manifest.mapLayerId}' 不是瓦片数据源`)
  }

  close(): Promise<void> {
    return this.rasterTiles.close()
  }
}

function validateTileCoordinate(z: number, x: number, y: number): void {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 24) throw new Error('地图瓦片坐标无效')
  const upper = 2 ** z
  if (x < 0 || y < 0 || x >= upper || y >= upper) throw new Error('地图瓦片坐标超出当前层级范围')
}

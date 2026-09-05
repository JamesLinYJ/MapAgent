// +-------------------------------------------------------------------------
//
//   地理智能平台 - GeoJSON 数据源渲染器
//
//   文件:       geoJsonSourceRenderer.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { defineSourceRenderer } from '../rendererTypes'
import { desktopMapResourceUrl } from '../desktopMapResourceUrl'

export const geoJsonSourceRenderer = defineSourceRenderer('geojson', (map, id, source, style) => {
  map.addSource(id, {
    type: 'geojson',
    data: desktopMapResourceUrl(source.url),
    ...(style.kind === 'point' && style.cluster
      ? { cluster: true, clusterRadius: 52, clusterMaxZoom: 13 }
      : {}),
  })
})
// +-------------------------------------------------------------------------
//
//   地理智能平台 - GeoJSON 数据源渲染器
//
//   文件:       geoJsonSourceRenderer.ts
// --------------------------------------------------------------------------

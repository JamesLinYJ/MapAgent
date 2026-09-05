// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图数据导出工具
//
//   文件:       mapExport.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 导出文件必须进入统一 artifact store；payload 和 valueRef 不暴露绝对路径。
// 文件名只用于展示，真实存储路径由 artifactId 决定。

import path from 'node:path'
import type { ToolDef } from '../../framework/types.js'
import { geoJsonSpatialMetadata, requireRenderableCrs84Bounds } from '../../gis/geojsonCrs.js'
import { atomicWriteText } from '../../store/durableFileIo.js'
import { makeId } from '../../utils/ids.js'
import { geoJsonInputSchema, resolveCanonicalGeoJsonInput } from '../spatial/geoJsonInput.js'
import { MAP_EXPORT_PROMPT } from '../spatial/prompts.js'

export function createMapExportTool(runtimeRoot: string): ToolDef {
  return {
    name: 'map_export',
    label: '导出 GeoJSON 数据',
    description: '将 GeoJSON 分析结果保存为可下载、可在平台地图中加载的 artifact；不生成 PNG/JPEG 或带标注的静态图片。',
    prompt: MAP_EXPORT_PROMPT,
    group: '空间分析',
    tags: ['export', 'file'],
    isReadOnly: false,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: {
        geojson: geoJsonInputSchema('要导出的 GeoJSON：优先传前序工具返回的 valueRef ID，也可传小型内联对象。'),
        filename: { type: 'string', description: '导出文件名（不含路径）', default: 'export.geojson' },
      },
      required: ['geojson'],
    },
    async handler(args, ctx) {
      const resolved = resolveCanonicalGeoJsonInput(args.geojson, ctx, 'geojson')
      const geojson = resolved.entity
      const filename = safeFilename(args.filename)
      const artifactId = makeId('artifact')
      const relativePath = path.posix.join('artifacts', ctx.runId, `${artifactId}.geojson`)
      const target = resolveRuntimePath(runtimeRoot, relativePath)
      const serialized = JSON.stringify(geojson, null, 2)
      const bounds = requireRenderableCrs84Bounds(resolved.bounds, '导出的 GeoJSON')
      await atomicWriteText(target, serialized)

      return {
        message: `地图数据已导出为 ${filename}`,
        payload: {
          operation: 'map_export',
          filename,
          artifactId,
          downloadUrl: `/api/v1/artifacts/${artifactId}/download`,
          featureCount: geojson.type === 'FeatureCollection' ? geojson.features.length : 1,
        },
        warnings: [],
        resultId: makeId('result'),
        source: 'artifact-store',
        provenance: { backend: 'artifact-store', format: 'geojson' },
        artifacts: [{
          artifactId,
          artifactType: 'geojson',
          name: filename,
          uri: `/api/v1/results/${artifactId}/geojson`,
          display: {
            surfaces: ['map', 'download'],
            primarySurface: 'map',
            map: {
              title: filename,
              replacementGroup: null,
              bounds,
              crs: resolved.crs,
              minZoom: 0,
              maxZoom: 22,
              source: {
                kind: 'geojson',
                url: `/api/v1/results/${artifactId}/geojson`,
                featureCount: geojson.type === 'FeatureCollection' ? geojson.features.length : 1,
                sizeBytes: Buffer.byteLength(serialized, 'utf8'),
              },
              style: {
                kind: 'line',
                color: '#2563eb',
                width: 2,
                dashArray: null,
                opacity: 0.9,
                colorField: null,
                categories: [],
              },
              legend: null,
              temporal: null,
              capabilities: {
                query: true,
                labels: true,
                style: true,
                temporal: false,
                opacity: true,
                download: true,
              },
            },
          },
          relativePath,
          metadata: {
            relativePath,
            downloadUrl: `/api/v1/artifacts/${artifactId}/download`,
            ...geoJsonSpatialMetadata(resolved),
          },
        }],
        valueRefs: [{
          refId: makeId('ref'),
          kind: 'artifact_ref',
          label: filename,
          value: { artifactId },
        }],
      }
    },
  }
}

function safeFilename(value: unknown): string {
  const requested = typeof value === 'string' && value.trim() ? value.trim() : 'export.geojson'
  const base = path.basename(requested).replace(/\.geojson$/iu, '')
  const normalized = base.replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^\.+/u, '').slice(0, 100).trim()
  return `${normalized || 'export'}.geojson`
}

function resolveRuntimePath(runtimeRoot: string, relativePath: string): string {
  const root = path.resolve(runtimeRoot)
  const target = path.resolve(root, relativePath)
  if (!target.startsWith(root + path.sep)) throw new Error('artifact 路径越出 runtime 根目录')
  return target
}

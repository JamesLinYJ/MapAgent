// +-------------------------------------------------------------------------
//
//   地理智能平台 - 空间分析 ToolProvider
//
//   文件:       index.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import manifest from './manifest.json' with { type: 'json' }
import type { ToolProvider } from '../../framework/types.js'
import { parseToolManifest } from '../../framework/schema.js'
import type { ManagedLayerService } from '../../gis/managedLayers/managedLayerService.js'
import { createLayerListTool } from '../layerList/layerList.js'
import { createLayerQueryTool } from '../layerQuery/layerQuery.js'
import { createSpatialAnalysisTool } from '../spatialAnalysis/spatialAnalysis.js'
import { createMapExportTool } from '../mapExport/mapExport.js'
import { createLayerCreateTool } from '../layerCreate/layerCreate.js'

export function createSpatialProvider(
  managedLayers: ManagedLayerService,
  deps: { runtimeRoot: string },
): ToolProvider {
  const runtimeRoot = deps.runtimeRoot
  return {
    manifest: parseToolManifest(manifest),
    tools: () => [
      createLayerListTool(managedLayers),
      createLayerQueryTool(managedLayers),
      createSpatialAnalysisTool(),
      createMapExportTool(runtimeRoot),
      createLayerCreateTool(managedLayers),
    ],
  }
}

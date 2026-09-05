// +-------------------------------------------------------------------------
//
//   地理智能平台 - 默认样式渲染器目录
//
//   文件:       index.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { MapStyleRenderer } from '../rendererTypes'
import { hillshadeStyleRenderer } from './hillshadeStyleRenderer'
import { rasterStyleRenderers } from './rasterStyleRenderers'
import { vectorStyleRenderers } from './vectorStyleRenderers'

export { buildLabelLayerDefinition } from './labelRenderer'

export const defaultStyleRenderers: MapStyleRenderer[] = [
  ...vectorStyleRenderers,
  ...rasterStyleRenderers,
  hillshadeStyleRenderer,
]
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 默认样式渲染器目录
//
//   文件:       index.ts
// --------------------------------------------------------------------------

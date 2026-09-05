// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图基线契约测试
//
//   文件:       mapBaselineContract.test.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const baselinePath = fileURLToPath(new URL('../../../../infra/database/schema.sql', import.meta.url))

describe('map database baseline contract', () => {
  it('keeps text feature identifiers as MVT attributes instead of numeric feature ids', async () => {
    const source = await readFile(baselinePath, 'utf8')
    const functionBody = source.match(
      /CREATE FUNCTION public\.geo_agent_platform_layer_tiles[\s\S]+?\$\$;/u,
    )?.[0]

    expect(functionBody).toBeDefined()
    expect(functionBody).toContain("ST_AsMVT(tile_features, 'features', 4096, 'geometry')")
    expect(functionBody).not.toContain("ST_AsMVT(tile_features, 'features', 4096, 'geometry', 'feature_id')")
    expect(functionBody).toContain('margin => (64.0 / 4096)')
    expect(functionBody).toContain('feature.geometry && query_bounds.geometry')
    expect(functionBody).not.toContain('ST_Intersects(ST_Transform(feature.geometry, 3857)')
  })

  it('persists label configuration with each scene layer', async () => {
    const baseline = await readFile(baselinePath, 'utf8')
    const sceneLayerTable = baseline.match(
      /CREATE TABLE public\.platform_map_scene_layers[\s\S]+?\);/u,
    )?.[0]

    expect(sceneLayerTable).toContain('label_json')
  })

  it('indexes explicit artifact replacement groups per thread', async () => {
    const baseline = await readFile(baselinePath, 'utf8')

    expect(baseline).toMatch(/replacement_group text/u)
    expect(baseline).toContain('idx_platform_map_layers_thread_replacement')
  })
})

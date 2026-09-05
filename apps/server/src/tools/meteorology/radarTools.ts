// +-------------------------------------------------------------------------
//
//   地理智能平台 - 天气雷达气象工具
//
//   文件:       radarTools.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult, ValueRef } from '../../framework/types.js'
import { makeId } from '../../utils/ids.js'
import {
  numberParameter,
  refParameter,
  selectParameter,
  textParameter,
  tool,
  type MeteorologyToolDeps,
  withMeteorologyDeps,
} from './toolDefinition.js'
import {
  artifactTarget,
  assertSuffix,
  downloadDisplay,
  isRecord,
  mergeArtifactMetadata,
  meteorologicalMembersFingerprint,
  miniAppDisplay,
  NETCDF_SUFFIXES,
  RADAR_PRODUCTS,
  rasterImageDisplay,
  refObject,
  requiredRefKind,
  result,
  thirdPartyProvenance,
  verifiedCollectionFiles,
  verifiedDatasetValue,
} from './toolRuntime.js'

export function createRadarMeteorologyTools(deps: MeteorologyToolDeps): ToolDef[] {
  return [
    tool('inspect_radar_station_collection', '检查雷达站文件集', '检查雷达 bz2 文件的站点和候选时次', {
      radar_collection_ref: refParameter('雷达文件集合引用', ['radar_file_collection']),
    }, withMeteorologyDeps(deps, inspectRadarStationCollection), ['radar_collection_ref']),
    tool('recommend_radar_mosaic_strategy', '推荐天气雷达组网拼图策略', '根据业务目标推荐天气雷达组网拼图算法策略', {
      goal_mode: selectParameter('业务目标', ['quicklook', 'quality', 'smooth']),
      time_strategy: selectParameter('时间策略', ['nearest', 'wide']),
    }, withMeteorologyDeps(deps, recommendRadarMosaicStrategy)),
    tool('render_radar_mosaic', '生成天气雷达组网拼图', '根据站点集合、时次和策略生成天气雷达组网拼图 PNG/NPZ', {
      radar_collection_ref: refParameter('雷达文件集合引用', ['radar_station_collection']),
      target_time_ref: refParameter('目标时次引用', ['radar_target_time']),
      strategy_ref: refParameter('拼图策略引用', ['radar_mosaic_strategy']),
      product: selectParameter('雷达产品', RADAR_PRODUCTS),
      level_index: numberParameter('层级索引'),
      tolerance_sec: numberParameter('时间容差秒'),
      grid_res_km: numberParameter('网格分辨率 km'),
      min_dbz: numberParameter('最小显示 dBZ'),
    }, withMeteorologyDeps(deps, renderRadarMosaic), ['radar_collection_ref', 'target_time_ref', 'strategy_ref']),
    tool('compare_radar_mosaic_reference', '对比天气雷达组网拼图与 NC 参考', '生成拼图结果与参考 NC 的差异对比图和滑块素材', {
      radar_mosaic_result_ref: refParameter('天气雷达组网拼图结果引用', ['radar_mosaic_result']),
      dataset_ref: refParameter('NC 参考数据引用', ['meteorological_dataset', 'meteorological_file']),
      target_time_ref: refParameter('目标时次引用', ['radar_target_time']),
      level_index: numberParameter('层级索引'),
      product_label: textParameter('产品标签'),
      product_unit: textParameter('产品单位'),
      min_display: numberParameter('最小对比显示值'),
    }, withMeteorologyDeps(deps, compareRadarMosaicReference), ['radar_mosaic_result_ref', 'dataset_ref', 'target_time_ref']),
  ]
}

async function inspectRadarStationCollection(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const collection = refObject(requiredRefKind(ctx, args, 'radar_collection_ref', ['radar_file_collection']).value)
  const files = await verifiedCollectionFiles(ctx, collection, 'radar_collection_ref')
  const membersFingerprint = meteorologicalMembersFingerprint(files)
  const worker = await deps.callWorker('inspect_radar_station_collection', { files }, ctx.signal)
  const refs: ValueRef[] = [{
    refId: makeId('ref'),
    kind: 'radar_station_collection',
    label: '雷达站文件集',
    value: { files, inspection: worker.payload, membersFingerprint },
    metadata: { sourceCollectionRef: args.radar_collection_ref, membersFingerprint },
  }]
  const candidateTimes = Array.isArray(worker.payload.candidateTimes) ? worker.payload.candidateTimes.filter(isRecord) : []
  for (const item of candidateTimes) {
    const timestamp = typeof item.timestamp === 'string' ? item.timestamp : ''
    if (!timestamp) continue
    refs.push({
      refId: makeId('ref'),
      kind: 'radar_target_time',
      label: `${timestamp} 雷达候选时次`,
      value: timestamp,
      metadata: { fileCount: item.fileCount, membersFingerprint },
    })
  }
  return result('inspect_radar_station_collection', worker.message, worker.payload, refs, [], thirdPartyProvenance('radar_mosaic_agent', {
    radarCollectionRef: args.radar_collection_ref,
  }))
}

async function recommendRadarMosaicStrategy(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const worker = await deps.callWorker('recommend_radar_mosaic_strategy', {
    goal_mode: typeof args.goal_mode === 'string' ? args.goal_mode : 'quicklook',
    time_strategy: typeof args.time_strategy === 'string' ? args.time_strategy : 'nearest',
  }, ctx.signal)
  const strategy = typeof worker.payload.strategy === 'string' ? worker.payload.strategy : ''
  if (!strategy) throw new Error('雷达策略推荐未返回 strategy')
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'radar_mosaic_strategy',
    label: `天气雷达组网拼图策略：${strategy}`,
    value: worker.payload,
  }
  return result('recommend_radar_mosaic_strategy', worker.message, worker.payload, [ref], [], thirdPartyProvenance('radar_mosaic_agent', {
    goalMode: args.goal_mode ?? 'quicklook',
    timeStrategy: args.time_strategy ?? 'nearest',
  }))
}

async function renderRadarMosaic(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const collection = refObject(requiredRefKind(ctx, args, 'radar_collection_ref', ['radar_station_collection']).value)
  const files = await verifiedCollectionFiles(ctx, collection, 'radar_collection_ref')
  const membersFingerprint = meteorologicalMembersFingerprint(files)
  const targetTimeRef = requiredRefKind(ctx, args, 'target_time_ref', ['radar_target_time'])
  if (targetTimeRef.metadata?.membersFingerprint !== membersFingerprint) {
    throw new Error('target_time_ref 与 radar_collection_ref 的数据集成员不匹配')
  }
  const targetTime = String(targetTimeRef.value)
  const strategySource = refObject(requiredRefKind(ctx, args, 'strategy_ref', ['radar_mosaic_strategy']).value)
  const strategy = typeof strategySource.strategy === 'string' ? strategySource.strategy : ''
  if (!strategy) throw new Error('strategy_ref 不包含天气雷达组网拼图策略')
  const png = artifactTarget(ctx, 'png', `${targetTime} 天气雷达组网拼图`)
  const mapPng = artifactTarget(ctx, 'png', `${targetTime} 天气雷达组网拼图地图图层`)
  const npz = artifactTarget(ctx, 'npz', `${targetTime} 天气雷达组网拼图数据`)
  const worker = await deps.callWorker('render_radar_mosaic', {
    files,
    target_time: targetTime,
    strategy,
    product: typeof args.product === 'string' ? args.product : 'reflectivity',
    level_index: typeof args.level_index === 'number' ? args.level_index : 0,
    tolerance_sec: typeof args.tolerance_sec === 'number' ? args.tolerance_sec : 300,
    grid_res_km: typeof args.grid_res_km === 'number' ? args.grid_res_km : 1,
    min_dbz: typeof args.min_dbz === 'number' ? args.min_dbz : 5,
    output_png_relative_path: png.relativePath,
    output_map_png_relative_path: mapPng.relativePath,
    output_npz_relative_path: npz.relativePath,
  }, ctx.signal)
  mergeArtifactMetadata(png, {
    ...worker.payload,
    previewRole: 'radar_mosaic',
  }, miniAppDisplay())
  mergeArtifactMetadata(mapPng, {
    ...worker.payload,
    previewRole: 'radar_mosaic_overlay',
    previewArtifactId: png.artifactId,
  }, rasterImageDisplay(mapPng, worker.payload))
  mergeArtifactMetadata(npz, {
    ...worker.payload,
    dataRole: 'radar_mosaic_npz',
  }, downloadDisplay())
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'radar_mosaic_result',
    label: `${targetTime} 天气雷达组网拼图结果`,
    value: {
      ...worker.payload,
      targetTime,
      pngArtifactId: png.artifactId,
      mapPngArtifactId: mapPng.artifactId,
      npzArtifactId: npz.artifactId,
      npzRelativePath: npz.relativePath,
      membersFingerprint,
    },
    metadata: { membersFingerprint },
  }
  return result('render_radar_mosaic', worker.message, worker.payload, [ref], [png, mapPng, npz], thirdPartyProvenance('radar_mosaic_agent', {
    radarCollectionRef: args.radar_collection_ref,
    targetTimeRef: args.target_time_ref,
    strategyRef: args.strategy_ref,
  }, [png, mapPng, npz]))
}

async function compareRadarMosaicReference(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const mosaic = refObject(requiredRefKind(ctx, args, 'radar_mosaic_result_ref', ['radar_mosaic_result']).value)
  const npzRelativePath = typeof mosaic.npzRelativePath === 'string' ? mosaic.npzRelativePath : ''
  if (!npzRelativePath) throw new Error('radar_mosaic_result_ref 缺少 NPZ 文件路径')
  const reference = await verifiedDatasetValue(ctx, requiredRefKind(ctx, args, 'dataset_ref', ['meteorological_dataset', 'meteorological_file']))
  assertSuffix(reference.name, NETCDF_SUFFIXES, 'NC 参考数据')
  const targetTimeRef = requiredRefKind(ctx, args, 'target_time_ref', ['radar_target_time'])
  if (typeof mosaic.membersFingerprint !== 'string' || targetTimeRef.metadata?.membersFingerprint !== mosaic.membersFingerprint) {
    throw new Error('target_time_ref 与 radar_mosaic_result_ref 的数据集成员不匹配')
  }
  const targetTime = String(targetTimeRef.value)
  const comparison = artifactTarget(ctx, 'png', `${targetTime} 天气雷达组网拼图对比`)
  const referencePng = artifactTarget(ctx, 'png', `${targetTime} NC 参考图`)
  const worker = await deps.callWorker('compare_radar_mosaic_reference', {
    mosaic_npz_relative_path: npzRelativePath,
    reference_files: [{ name: reference.name, relativePath: reference.relativePath }],
    target_time: targetTime,
    level_index: typeof args.level_index === 'number' ? args.level_index : 0,
    product_label: typeof args.product_label === 'string' ? args.product_label : undefined,
    product_unit: typeof args.product_unit === 'string' ? args.product_unit : undefined,
    min_display: typeof args.min_display === 'number' ? args.min_display : undefined,
    output_png_relative_path: comparison.relativePath,
    output_reference_png_relative_path: referencePng.relativePath,
  }, ctx.signal)
  mergeArtifactMetadata(comparison, {
    ...worker.payload,
    previewRole: 'radar_reference_comparison',
    baseImageArtifactId: referencePng.artifactId,
    overlayImageArtifactId: comparison.artifactId,
  }, miniAppDisplay())
  mergeArtifactMetadata(referencePng, {
    ...worker.payload,
    previewRole: 'radar_reference_image',
    baseImageArtifactId: referencePng.artifactId,
    overlayImageArtifactId: comparison.artifactId,
  }, miniAppDisplay())
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'radar_mosaic_comparison',
    label: `${targetTime} 天气雷达组网拼图对比统计`,
    value: {
      ...worker.payload,
      comparisonArtifactId: comparison.artifactId,
      referenceArtifactId: referencePng.artifactId,
    },
  }
  return result('compare_radar_mosaic_reference', worker.message, worker.payload, [ref], [comparison, referencePng], thirdPartyProvenance('radar_mosaic_agent', {
    mosaicRef: args.radar_mosaic_result_ref,
    datasetRef: args.dataset_ref,
    targetTimeRef: args.target_time_ref,
  }, [comparison, referencePng]))
}

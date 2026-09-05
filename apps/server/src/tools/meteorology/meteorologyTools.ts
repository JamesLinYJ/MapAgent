// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象工具 Provider 适配器
//
//   文件:       meteorologyTools.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { Env } from '../../framework/env.js'
import type { ToolContext, ToolDef, ToolResult, ValueRef } from '../../framework/types.js'
import { geoJsonSpatialMetadata } from '../../gis/geojsonCrs.js'
import { makeId } from '../../utils/ids.js'
import { callMeteorologyWorker } from './meteorologyWorkerClient.js'
import { createDatasetMeteorologyTools } from './datasetTools.js'
import { createNowcastMeteorologyTools } from './nowcastTools.js'
import { createNowcastResultTools } from './nowcastResultTools.js'
import { createRadarMeteorologyTools } from './radarTools.js'
import {
  jsonParameter,
  numberParameter,
  refParameter,
  selectParameter,
  textParameter,
  tool,
  type MeteorologyToolDeps,
  withMeteorologyDeps,
} from './toolDefinition.js'
import {
  areaRainfallStyleSchema,
  artifactTarget,
  assertFileObjectsSuffix,
  BOUNDARY_REF_KINDS,
  boundaryInputRelativePath,
  convertMeteorologicalUnitValue,
  defaultAreaRainfallStyle,
  defaultRainfallThresholds,
  downloadDisplay,
  geoJsonDisplay,
  inputKind,
  isRecord,
  mergeArtifactMetadata,
  meteorologicalLineageMetadata,
  miniAppDisplay,
  METEOROLOGICAL_FILE_SUFFIXES,
  NETCDF_SUFFIXES,
  normalizeGeoJsonArtifactFile,
  normalizeThresholds,
  rainfallThresholdsSchema,
  refObject,
  requiredRefKind,
  result,
  requireMatchingMeteorologicalLineage,
  requireMatchingMeteorologicalVariable,
  thirdPartyProvenance,
  verifiedCollectionFiles,
  verifiedDatasetValue,
  verifiedSequenceFiles,
  valueRefUnit,
} from './toolRuntime.js'

export function createMeteorologyTools(env: Env): ToolDef[] {
  const deps: MeteorologyToolDeps = {
    runtimeRoot: env.RUNTIME_ROOT,
    callWorker: (name, args, signal) => callMeteorologyWorker({
      ...(env.WORKER_URL ? { workerUrl: env.WORKER_URL } : {}),
      ...(env.WORKER_SHARED_SECRET ? { workerSharedSecret: env.WORKER_SHARED_SECRET } : {}),
      requestTimeoutMs: env.WORKER_REQUEST_TIMEOUT_MS,
    }, name, args, signal),
  }

  return [
  tool(
    'list_meteorological_files',
    '列出气象文件',
    '按当前会话或当前线程列出可用的通用气象数据集',
    {
      scope: selectParameter('数据集范围；session 可跨对话复用，thread 只包含当前对话上传的数据', ['session', 'thread']),
    },
    listMeteorologicalFiles,
    [],
  ),
  ...createRadarMeteorologyTools(deps),
  ...createDatasetMeteorologyTools(deps),
  tool('define_rainfall_risk_thresholds', '定义短时强降水风险阈值', '保存短时强降水风险区划图使用的阈值和调色板', {
    dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
    variable_ref: refParameter('降水变量引用', ['meteorological_variable']),
    thresholds: jsonParameter('阈值调色板 JSON', rainfallThresholdsSchema(), defaultRainfallThresholds()),
  }, defineRainfallRiskThresholds, ['dataset_ref', 'variable_ref']),
  tool('render_rainfall_risk_map', '生成短时强降水风险区划图', '使用单个 NC 数据集、变量、边界和阈值生成风险/渐变/对比图；dataset_ref 必须来自 meteorological_inspect 的 meteorological_dataset，不接受 nowcast_sequence', {
    dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
    variable_ref: refParameter('变量引用', ['meteorological_variable']),
    boundary_ref: refParameter('边界引用', BOUNDARY_REF_KINDS),
    thresholds_ref: refParameter('阈值引用', ['rainfall_risk_thresholds']),
    map_mode: selectParameter('图件模式', ['regional', 'gradient', 'compare']),
    aggregation: selectParameter('区划聚合', ['mean', 'max', 'sum']),
    label_field: textParameter('区划名称字段'),
    title: textParameter('图名'),
  }, withMeteorologyDeps(deps, renderRainfallRiskMap), ['dataset_ref', 'variable_ref', 'boundary_ref', 'thresholds_ref']),
  tool('generate_area_rainfall_table', '生成区域累计面雨量排行表', '使用 NC 文件集合或短时临近预报序列生成区域累计面雨量排行 Excel 和 PNG 表格；多文件输入表示时段累加面雨量，不是单时次均值', {
    file_collection_ref: refParameter('NC 文件集合或短时临近预报序列引用', ['meteorological_file_collection', 'nowcast_sequence']),
    boundary_ref: refParameter('边界文件引用', BOUNDARY_REF_KINDS),
    top_n: numberParameter('展示前 N 个区域'),
    label_field: textParameter('区划名称字段'),
    style: jsonParameter('表格样式 JSON', areaRainfallStyleSchema(), defaultAreaRainfallStyle()),
  }, withMeteorologyDeps(deps, generateAreaRainfallTable), ['file_collection_ref', 'boundary_ref']),
  ...createNowcastMeteorologyTools(deps),
  ...createNowcastResultTools(deps),
  ]
}

async function listMeteorologicalFiles(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.listMeteorologicalDatasets) throw new Error('气象数据集目录服务未配置')
  const scope = meteorologicalDatasetScope(args.scope)
  if (scope === 'thread' && !ctx.threadId) {
    throw new Error('当前运行没有 threadId，不能列出 thread 范围的气象数据集')
  }
  // session 用于跨对话复用，thread 用于把“刚上传的一批”严格隔离在当前对话。
  // 两种范围都按数据库更新时间保留同一来源路径的最新条目。
  const entries = (await ctx.listMeteorologicalDatasets({ scope, limit: 500 }))
    .filter(entry => entry.status === 'ready')
    .filter(entry => METEOROLOGICAL_FILE_SUFFIXES.some(suffix => entry.filename.toLowerCase().endsWith(suffix)))
    .filter((entry, index, all) => all.findIndex(candidate => datasetSourceKey(candidate) === datasetSourceKey(entry)) === index)
  const fileRefs: ValueRef[] = entries.map(entry => {
    const contentHash = entry.contentHash?.trim()
    if (!contentHash) throw new Error(`气象数据集 '${entry.datasetId}' 缺少 contentHash，不能生成可执行 valueRef`)
    return {
      refId: makeId('ref'),
      kind: 'meteorological_file',
      label: entry.filename,
      value: {
        datasetId: entry.datasetId,
        contentHash,
        fileId: entry.fileId,
        name: entry.filename,
        relativePath: entry.fileRelativePath,
        ...(datasetSourceRelativePath(entry) ? { sourceRelativePath: datasetSourceRelativePath(entry) } : {}),
      },
      metadata: {
        datasetId: entry.datasetId,
        contentHash,
        threadId: entry.threadId,
        sessionId: entry.sessionId,
        sizeBytes: entry.sizeBytes,
        inputKind: inputKind(entry.filename),
        ...(datasetSourceRelativePath(entry) ? { sourceRelativePath: datasetSourceRelativePath(entry) } : {}),
      },
    }
  })
  const datasetFiles = fileRefs.filter(ref => ref.metadata?.inputKind === 'dataset').map(ref => refObject(ref.value))
  const radarFiles = fileRefs.filter(ref => ref.metadata?.inputKind === 'radar').map(ref => refObject(ref.value))
  const boundaryFiles = fileRefs.filter(ref => ref.metadata?.inputKind === 'boundary').map(ref => refObject(ref.value))
  const collection: ValueRef = {
    refId: makeId('ref'),
    kind: 'meteorological_file_collection',
    label: `${datasetFiles.length} 个气象数据文件`,
    value: { files: datasetFiles },
  }
  const radarCollection: ValueRef | null = radarFiles.length ? {
    refId: makeId('ref'),
    kind: 'radar_file_collection',
    label: `${radarFiles.length} 个雷达 bz2 文件`,
    value: { files: radarFiles },
  } : null
  const boundaryCollection: ValueRef | null = boundaryFiles.length ? {
    refId: makeId('ref'),
    kind: 'meteorological_boundary_collection',
    label: `${boundaryFiles.length} 个边界文件`,
    value: { files: boundaryFiles },
  } : null
  return result('list_meteorological_files', `在${scope === 'thread' ? '当前对话' : '当前会话'}找到 ${entries.length} 个气象相关文件`, {
    scope,
    files: entries.map(entry => ({
      datasetId: entry.datasetId,
      name: entry.filename,
      sourceRelativePath: datasetSourceRelativePath(entry),
      sizeBytes: entry.sizeBytes,
      status: entry.status,
      uploadedFromThreadId: entry.threadId,
    })),
    counts: { dataset: datasetFiles.length, radar: radarFiles.length, boundary: boundaryFiles.length },
  }, [
    ...fileRefs,
    collection,
    ...(radarCollection ? [radarCollection] : []),
    ...(boundaryCollection ? [boundaryCollection] : []),
  ])
}

function meteorologicalDatasetScope(value: unknown): 'session' | 'thread' {
  if (value === undefined || value === 'session') return 'session'
  if (value === 'thread') return 'thread'
  throw new Error('scope 只允许 session 或 thread。')
}

function datasetSourceRelativePath(entry: { metadata: Record<string, unknown> }): string | null {
  const value = entry.metadata.sourceRelativePath
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function datasetSourceKey(entry: { filename: string; metadata: Record<string, unknown> }): string {
  return datasetSourceRelativePath(entry) ?? entry.filename
}

async function defineRainfallRiskThresholds(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const dataset = await verifiedDatasetValue(ctx, requiredRefKind(ctx, args, 'dataset_ref', ['meteorological_dataset']))
  const variableRef = requireMatchingMeteorologicalLineage(
    requiredRefKind(ctx, args, 'variable_ref', ['meteorological_variable']),
    dataset.lineage,
    'variable_ref',
  )
  const variable = refObject(variableRef.value)
  const variableName = typeof variable.name === 'string' ? variable.name.trim() : ''
  if (!variableName) throw new Error('variable_ref 不包含变量名')
  // 风险阈值契约固定以 mm 表达；渲染时再显式换算到数据变量单位。
  convertMeteorologicalUnitValue(0, 'mm', valueRefUnit(variableRef), 'variable_ref')
  const thresholds = normalizeThresholds(args.thresholds)
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'rainfall_risk_thresholds',
    label: '短时强降水风险阈值调色板',
    value: { thresholds, unit: 'mm', variable: variableName },
    unit: 'mm',
    metadata: meteorologicalLineageMetadata(dataset.lineage, variableName),
  }
  return result('define_rainfall_risk_thresholds', `已定义 ${thresholds.length} 个短时强降水风险等级`, { thresholds }, [ref], [], thirdPartyProvenance('rainfall_risk_map', {
    thresholdCount: thresholds.length,
  }))
}

async function renderRainfallRiskMap(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const datasetRef = requiredRefKind(ctx, args, 'dataset_ref', ['meteorological_dataset'])
  const dataset = await verifiedDatasetValue(ctx, datasetRef)
  const variableRef = requireMatchingMeteorologicalLineage(
    requiredRefKind(ctx, args, 'variable_ref', ['meteorological_variable']),
    dataset.lineage,
    'variable_ref',
  )
  const variable = refObject(variableRef.value)
  const variableName = typeof variable.name === 'string' ? variable.name : ''
  if (!variableName) throw new Error('variable_ref 不包含变量名')
  const thresholdsRef = requireMatchingMeteorologicalLineage(
    requiredRefKind(ctx, args, 'thresholds_ref', ['rainfall_risk_thresholds']),
    dataset.lineage,
    'thresholds_ref',
  )
  requireMatchingMeteorologicalVariable(thresholdsRef, variableName, 'thresholds_ref')
  const thresholds = refObject(thresholdsRef.value)
  const normalizedThresholds = normalizeThresholds(thresholds.thresholds).map(item => ({
    ...item,
    min: convertMeteorologicalUnitValue(item.min, valueRefUnit(thresholdsRef), valueRefUnit(variableRef), 'thresholds_ref'),
    max: convertMeteorologicalUnitValue(item.max, valueRefUnit(thresholdsRef), valueRefUnit(variableRef), 'thresholds_ref'),
  }))
  const boundaryRelativePath = await boundaryInputRelativePath(ctx, args, 'boundary_ref', deps)
  const artifact = artifactTarget(ctx, 'png', `${dataset.name} 短时强降水风险区划图`)
  const regionLayer = artifactTarget(ctx, 'geojson', `${dataset.name} 短时强降水风险区划图层`)
  const worker = await deps.callWorker('render_rainfall_risk_map', {
    file_relative_path: dataset.relativePath,
    file_name: dataset.name,
    variable: variableName,
    boundary_relative_path: boundaryRelativePath,
    thresholds: normalizedThresholds,
    map_mode: typeof args.map_mode === 'string' ? args.map_mode : 'regional',
    aggregation: typeof args.aggregation === 'string' ? args.aggregation : 'mean',
    label_field: typeof args.label_field === 'string' ? args.label_field : undefined,
    title: typeof args.title === 'string' ? args.title : undefined,
    output_relative_path: artifact.relativePath,
    output_geojson_relative_path: regionLayer.relativePath,
  }, ctx.signal)
  const canonicalRegionLayer = await normalizeGeoJsonArtifactFile(
    deps,
    regionLayer.relativePath,
    worker.payload.crs ?? worker.payload.coordinateCrs,
  )
  mergeArtifactMetadata(artifact, {
    ...worker.payload,
    previewRole: 'rainfall_risk_map',
    miniApp: { type: 'rainfall_risk_map_console' },
  }, miniAppDisplay())
  const mapCategories = normalizeThresholds(worker.payload.thresholds).map(item => ({
    value: item.label,
    label: `${item.label}（${item.min}–${item.max}）`,
    color: item.color,
  }))
  mergeArtifactMetadata(regionLayer, {
    mapRole: 'rainfall_risk_regions',
    variable: worker.payload.variable,
    units: worker.payload.units,
    mapMode: worker.payload.mapMode,
    aggregation: worker.payload.aggregation,
    thresholds: worker.payload.thresholds,
    regionSummary: worker.payload.regionSummary,
    previewArtifactId: artifact.artifactId,
    miniApp: { type: 'rainfall_risk_map_console' },
    ...geoJsonSpatialMetadata(canonicalRegionLayer),
  }, geoJsonDisplay(regionLayer, canonicalRegionLayer.entity as unknown as Record<string, unknown>, 'polygon', {
    bounds: canonicalRegionLayer.bounds,
    coordinateCrs: canonicalRegionLayer.crs,
    featureCount: canonicalRegionLayer.featureCount,
    sizeBytes: canonicalRegionLayer.sizeBytes,
    colorField: 'risk_level',
    categories: mapCategories,
    legendTitle: '短时强降水风险等级',
  }))
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'rainfall_risk_map_result',
    label: `${dataset.name} 短时强降水风险区划图结果`,
    value: { ...worker.payload, artifactId: artifact.artifactId, geojsonArtifactId: regionLayer.artifactId },
  }
  return result('render_rainfall_risk_map', worker.message, worker.payload, [ref], [artifact, regionLayer], thirdPartyProvenance('rainfall_risk_map', {
    datasetRef: args.dataset_ref,
    variableRef: args.variable_ref,
    boundaryRef: args.boundary_ref,
    thresholdsRef: args.thresholds_ref,
  }, [artifact, regionLayer]))
}

async function generateAreaRainfallTable(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const collectionRef = requiredRefKind(ctx, args, 'file_collection_ref', ['meteorological_file_collection', 'nowcast_sequence'])
  const files = collectionRef.kind === 'nowcast_sequence'
    ? await verifiedSequenceFiles(ctx, refObject(collectionRef.value), 'file_collection_ref')
    : await verifiedCollectionFiles(ctx, refObject(collectionRef.value), 'file_collection_ref')
  if (!files.length) throw new Error('区域累计面雨量排行表需要至少一个 NC 文件')
  assertFileObjectsSuffix(files, NETCDF_SUFFIXES, '区域累计面雨量排行表')
  const boundaryRelativePath = await boundaryInputRelativePath(ctx, args, 'boundary_ref', deps)
  const xlsx = artifactTarget(ctx, 'xlsx', '面雨量排行表格')
  const png = artifactTarget(ctx, 'png', '面雨量排行预览')
  const worker = await deps.callWorker('generate_area_rainfall_table', {
    files,
    boundary_relative_path: boundaryRelativePath,
    top_n: typeof args.top_n === 'number' ? args.top_n : 10,
    label_field: typeof args.label_field === 'string' ? args.label_field : undefined,
    style: isRecord(args.style) ? args.style : undefined,
    output_xlsx_relative_path: xlsx.relativePath,
    output_png_relative_path: png.relativePath,
  }, ctx.signal)
  mergeArtifactMetadata(xlsx, {
    ...worker.payload,
    downloadRole: 'area_rainfall_table_xlsx',
  }, downloadDisplay())
  mergeArtifactMetadata(png, {
    ...worker.payload,
    previewRole: 'area_rainfall_table_png',
    miniApp: { type: 'area_rainfall_table_console' },
  }, miniAppDisplay())
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'area_rainfall_table_result',
    label: '区域累计面雨量排行表结果',
    value: { ...worker.payload, xlsxArtifactId: xlsx.artifactId, pngArtifactId: png.artifactId },
  }
  return result('generate_area_rainfall_table', worker.message, worker.payload, [ref], [xlsx, png], thirdPartyProvenance('short_term_forecast', {
    fileCollectionRef: args.file_collection_ref,
    boundaryRef: args.boundary_ref,
  }, [xlsx, png]))
}

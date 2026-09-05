// +-------------------------------------------------------------------------
//
//   地理智能平台 - 短时临近预报工具
//
//   文件:       nowcastTools.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-31):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 短临预报文本直接采用领域 Worker 的确定性结果，不再调用模型复述。
// --------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult, ValueRef } from '../../framework/types.js'
import { geoJsonSpatialMetadata, normalizeGeoJsonToCrs84, requireRenderableCrs84Bounds } from '../../gis/geojsonCrs.js'
import { makeId } from '../../utils/ids.js'
import {
  numberParameter,
  refParameter,
  textParameter,
  tool,
  type MeteorologyToolDeps,
  withMeteorologyDeps,
} from './toolDefinition.js'
import {
  artifactTarget,
  coordinateFromRef,
  featureCollectionFromBoundaryRef,
  isRecord,
  mergeArtifactMetadata,
  miniAppDisplay,
  nowcastRenderBbox,
  refObject,
  requireMeteorologicalLineage,
  requiredCandidateText,
  requiredRefKind,
  requiredText,
  rasterTileDisplay,
  result,
  resultRefs,
  selectNowcastMapCandidate,
  verifiedCollectionFiles,
  verifiedFileObject,
  verifiedSequenceFiles,
  valueRefUnit,
} from './toolRuntime.js'

const AUTOMATION_TOOL_OPTIONS: Pick<ToolDef, 'executionSurfaces'> = {
  executionSurfaces: ['automation', 'debug'],
}

const NOWCAST_SCOPE_REF_KINDS = [
  'feature_collection',
  'nowcast_area',
  'layer',
  'nowcast_coordinate',
  'place_candidate',
  'bbox',
]

export function createNowcastMeteorologyTools(deps: MeteorologyToolDeps): ToolDef[] {
  return [
    tool('create_nowcast_sequence', '创建短时临近预报序列', '从当前线程气象文件集合创建短时临近预报序列引用；仅用于短时临近预报问答、连续时次分析和区域累计面雨量排行表，不作为短时强降水风险区划图 dataset_ref', {
      file_collection_ref: refParameter('文件集合引用', ['meteorological_file_collection']),
      variable_ref: refParameter('变量引用', ['meteorological_variable']),
      horizon_minutes: { ...numberParameter('预报时效（分钟）'), type: 'integer', minimum: 5, maximum: 360 },
    }, withMeteorologyDeps(deps, createNowcastSequence), ['file_collection_ref'], AUTOMATION_TOOL_OPTIONS),
    tool('inspect_nowcast_sequence', '检查短时临近预报序列', '检查短时临近预报序列每个时次的数据集', {
      sequence_ref: refParameter('短时临近预报序列引用', ['nowcast_sequence']),
    }, withMeteorologyDeps(deps, inspectNowcastSequence), ['sequence_ref'], AUTOMATION_TOOL_OPTIONS),
    tool('prepare_nowcast_scope', '准备短时临近预报范围', '根据问题和已有边界/坐标引用准备区划或地点范围', {
      question: textParameter('短时临近预报（短临）问题'),
      scope_ref: refParameter('已有边界、范围或地点引用', NOWCAST_SCOPE_REF_KINDS),
      area_name: textParameter('区划名称'),
      district_name_field: textParameter('区划名称字段'),
    }, prepareNowcastScope, ['question'], AUTOMATION_TOOL_OPTIONS),
    tool('meteorological_precipitation_nowcast', '分析短时临近预报（短临）降水', '按时次和区划或地点范围计算降水统计事实', {
      sequence_ref: refParameter('短时临近预报序列引用', ['nowcast_sequence']),
      variable_ref: refParameter('变量引用', ['meteorological_variable']),
      scope_ref: refParameter('区划、范围或地点引用', NOWCAST_SCOPE_REF_KINDS),
    }, withMeteorologyDeps(deps, analyzeNowcast), ['sequence_ref'], AUTOMATION_TOOL_OPTIONS),
    tool('answer_nowcast_question', '回答短时临近预报（短临）问题', '根据短时临近预报（短临）分析事实回答明确问题并生成代表时次地图', {
      nowcast_analysis_ref: refParameter('短时临近预报（短临）分析引用', ['nowcast_analysis']),
      question: textParameter('问题'),
    }, withMeteorologyDeps(deps, answerNowcast), ['nowcast_analysis_ref', 'question'], AUTOMATION_TOOL_OPTIONS),
    tool('generate_nowcast_forecast_text', '生成短时临近预报（短临）预报文本', '保存领域 Worker 根据短时临近预报（短临）分析事实生成的确定性文本', {
      nowcast_analysis_ref: refParameter('短时临近预报（短临）分析引用', ['nowcast_analysis']),
    }, withMeteorologyDeps(deps, generateNowcastText), ['nowcast_analysis_ref'], AUTOMATION_TOOL_OPTIONS),
    tool('render_nowcast_raster', '渲染短时临近预报（短临）栅格', '生成短时临近预报候选时次 COG 地图与 PNG 预览', {
      nowcast_map_candidate_ref: refParameter('短时临近预报（短临）地图候选引用', ['nowcast_map_candidate']),
    }, withMeteorologyDeps(deps, renderNowcastRaster), ['nowcast_map_candidate_ref'], AUTOMATION_TOOL_OPTIONS),
  ]
}

async function createNowcastSequence(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const collection = refObject(requiredRefKind(ctx, args, 'file_collection_ref', ['meteorological_file_collection']).value)
  if (!Array.isArray(collection.files) || collection.files.length < 2) throw new Error('短时临近预报序列至少需要两个气象文件')
  const files = await verifiedCollectionFiles(ctx, collection, 'file_collection_ref')
  const variableAffinity = optionalSequenceVariable(ctx, args, files)
  const variable = variableAffinity?.name
  const horizonMinutes = args.horizon_minutes === undefined ? undefined : Number(args.horizon_minutes)
  if (horizonMinutes !== undefined && (!Number.isInteger(horizonMinutes) || horizonMinutes < 5 || horizonMinutes > 360)) {
    throw new Error('horizon_minutes 必须是 5 到 360 之间的整数')
  }
  const worker = await deps.callWorker('create_nowcast_sequence', {
    files,
    variable,
    horizon_minutes: horizonMinutes,
  }, ctx.signal)
  const payload = {
    ...enrichSequencePayload(worker.payload, files),
    ...(variableAffinity ? { variableAffinity } : {}),
  }
  const ref: ValueRef = {
    refId: makeId('ref'), kind: 'nowcast_sequence', label: '短时临近预报（短临）气象序列',
    value: payload,
  }
  return result('create_nowcast_sequence', worker.message, payload, [ref])
}

async function inspectNowcastSequence(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const { sequence } = await verifiedSequencePayload(ctx, refObject(requiredRefKind(ctx, args, 'sequence_ref', ['nowcast_sequence']).value))
  const worker = await deps.callWorker('inspect_nowcast_sequence', { sequence }, ctx.signal)
  const ref: ValueRef = { refId: makeId('ref'), kind: 'nowcast_sequence_inspection', label: '短时临近预报序列检查', value: worker.payload }
  return result('inspect_nowcast_sequence', worker.message, worker.payload, [ref])
}

async function prepareNowcastScope(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const question = requiredText(args, 'question')
  const requestedArea = typeof args.area_name === 'string' && args.area_name.trim()
    ? args.area_name.trim()
    : stripNowcastQuestion(question)
  const scopeRefId = typeof args.scope_ref === 'string' ? args.scope_ref.trim() : ''

  if (scopeRefId) {
    const scopeRef = requiredRefKind(ctx, args, 'scope_ref', NOWCAST_SCOPE_REF_KINDS)
    if (scopeRef.kind === 'nowcast_coordinate' || scopeRef.kind === 'place_candidate') {
      const coordinate = coordinateFromRef(scopeRef)
      const ref: ValueRef = {
        refId: makeId('ref'),
        kind: 'nowcast_coordinate',
        label: coordinate.label,
        value: coordinate,
        metadata: { sourceRef: scopeRef.refId },
      }
      return result('prepare_nowcast_scope', `已准备地点范围：${coordinate.label}`, {
        scopeType: 'coordinate', label: coordinate.label,
      }, [ref])
    }

    if (scopeRef.kind === 'bbox') {
      const bbox = canonicalBboxFromRef(scopeRef, 'scope_ref')
      const ref: ValueRef = {
        refId: makeId('ref'),
        kind: 'bbox',
        label: scopeRef.label,
        value: bbox,
        metadata: { sourceRef: scopeRef.refId, crs: 'OGC:CRS84' },
      }
      return result('prepare_nowcast_scope', `已准备范围：${scopeRef.label}`, {
        scopeType: 'bbox', label: scopeRef.label,
      }, [ref])
    }

    const canonical = canonicalBoundaryFromRef(scopeRef, 'scope_ref')
    if (canonical.entity.type !== 'FeatureCollection') throw new Error('scope_ref 必须解析为 FeatureCollection')
    const boundary = canonical.entity
    const districtNameField = typeof args.district_name_field === 'string' && args.district_name_field.trim()
      ? args.district_name_field.trim()
      : typeof scopeRef.metadata?.districtNameField === 'string'
        ? scopeRef.metadata.districtNameField
        : 'name'
    const features = requestedArea
      ? boundary.features.filter(feature => isRecord(feature) && isRecord(feature.properties) && feature.properties[districtNameField] === requestedArea)
      : boundary.features
    if (!features.length) throw new Error(`已有区划边界中未找到 ${requestedArea}`)
    const collection = { type: 'FeatureCollection', features }
    const ref: ValueRef = {
      refId: makeId('ref'),
      kind: 'nowcast_area',
      label: requestedArea || '区划边界',
      value: collection,
      metadata: { sourceRef: scopeRef.refId, districtNameField, ...geoJsonSpatialMetadata(canonical) },
    }
    const boundaryRef: ValueRef = {
      refId: makeId('ref'),
      kind: 'feature_collection',
      label: requestedArea ? `${requestedArea}区划边界` : '区划边界',
      value: collection,
      metadata: { sourceRef: scopeRef.refId, districtNameField, purpose: 'nowcast_scope', ...geoJsonSpatialMetadata(canonical) },
    }
    return result('prepare_nowcast_scope', `已准备 ${features.length} 个区划范围`, {
      scopeType: 'area', label: ref.label, featureCount: features.length,
    }, [ref, boundaryRef])
  }

  throw new Error('短时临近预报范围必须来自平台已有图层、上传边界或当前 run 的 valueRef。请先使用 list_layers 检索目标区划图层，或提供 nowcast_coordinate/place_candidate 引用；本工具不会联网解析地点或伪造边界。')
}

async function analyzeNowcast(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const { sequence, files } = await verifiedSequencePayload(ctx, refObject(requiredRefKind(ctx, args, 'sequence_ref', ['nowcast_sequence']).value))
  const variableAffinity = optionalSequenceVariable(ctx, args, files)
  const scope = optionalScope(ctx, args)
  const worker = await deps.callWorker('meteorological_precipitation_nowcast', {
    sequence,
    variable: variableAffinity?.name ?? sequence.variable,
    ...scope,
  }, ctx.signal)
  const rawCandidates = Array.isArray(worker.payload.mapCandidates) ? worker.payload.mapCandidates.filter(isRecord) : []
  const candidates = rawCandidates.map((candidate, index) => enrichDatasetOutput(candidate, files, `mapCandidates[${index}]`))
  const payload = { ...worker.payload, mapCandidates: candidates }
  const refs: ValueRef[] = [{
    refId: makeId('ref'), kind: 'nowcast_analysis', label: '短时临近预报（短临）降水分析', value: payload,
  }]
  for (const item of candidates) {
    refs.push({
      refId: makeId('ref'), kind: 'nowcast_map_candidate', label: String(item.label ?? item.filename ?? '短时临近预报（短临）地图候选'),
      value: item,
    })
  }
  return result('meteorological_precipitation_nowcast', worker.message, payload, refs)
}

function stripNowcastQuestion(question: string): string {
  return question
    .replace(/[？?。]/gu, '')
    .replace(/未来三小时|未来3小时|接下来|短时临近预报（短临）|降水|降雨|天气怎么样|天气如何|会不会下雨|会下雨吗|下雨吗/gu, '')
    .trim()
}

function optionalScope(ctx: ToolContext, args: Record<string, unknown>): Record<string, unknown> {
  const refId = args.scope_ref
  if (typeof refId !== 'string' || !refId.trim()) return {}
  const ref = requiredRefKind(ctx, args, 'scope_ref', NOWCAST_SCOPE_REF_KINDS)
  if (ref.kind === 'nowcast_area' || ref.kind === 'feature_collection' || ref.kind === 'layer') {
    const canonical = canonicalBoundaryFromRef(ref, 'scope_ref')
    return {
      area: canonical.entity,
      district_name_field: typeof ref.metadata?.districtNameField === 'string' ? ref.metadata.districtNameField : undefined,
    }
  }
  if (ref.kind === 'nowcast_coordinate' || ref.kind === 'place_candidate') {
    const value = refObject(ref.value)
    return {
      coordinate: {
        lat: Number(value.lat),
        lng: Number(value.lng ?? value.lon),
        label: typeof value.label === 'string' ? value.label : ref.label,
      },
      point_buffer_meters: 1000,
    }
  }
  if (ref.kind === 'bbox') return { bbox: canonicalBboxFromRef(ref, 'scope_ref') }
  throw new Error(`scope_ref 必须引用区划、地点坐标或 bbox，实际为 ${ref.kind}`)
}

function canonicalBoundaryFromRef(ref: ValueRef, key: string) {
  return normalizeGeoJsonToCrs84(
    featureCollectionFromBoundaryRef(ref, key),
    `${key} '${ref.refId}'`,
    ref.metadata?.crs,
  )
}

function canonicalBboxFromRef(ref: ValueRef, key: string): [number, number, number, number] {
  const raw = Array.isArray(ref.value)
    ? ref.value
    : isRecord(ref.value) && Array.isArray(ref.value.bounds)
      ? ref.value.bounds
      : isRecord(ref.value) && Array.isArray(ref.value.bbox)
        ? ref.value.bbox
        : null
  if (!raw || raw.length !== 4 || !raw.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error(`${key} 必须包含四个有限数值组成的 bbox`)
  }
  const [west, south, east, north] = raw as [number, number, number, number]
  if (west >= east || south >= north) throw new Error(`${key} bbox 的 west/east 或 south/north 顺序无效`)
  const canonical = normalizeGeoJsonToCrs84({
    type: 'Polygon',
    coordinates: [[
      [west, south], [east, south], [east, north], [west, north], [west, south],
    ]],
  }, `${key} '${ref.refId}'`, ref.metadata?.crs)
  return requireRenderableCrs84Bounds(canonical.bounds, key)
}

async function answerNowcast(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const analysis = refObject(requiredRefKind(ctx, args, 'nowcast_analysis_ref', ['nowcast_analysis']).value)
  const worker = await deps.callWorker(
    'answer_nowcast_question',
    { analysis, question: requiredText(args, 'question') },
    ctx.signal,
  )
  const ref: ValueRef = { refId: makeId('ref'), kind: 'nowcast_answer', label: '短时临近预报（短临）问题回答事实', value: worker.payload }
  const candidate = selectNowcastMapCandidate(analysis)
  const rendered = await renderCandidateArtifacts(
    ctx,
    deps,
    candidate,
    `${String(candidate.label ?? '代表时次')} 短时临近预报（短临）降水`,
    nowcastRenderBbox(analysis),
  )
  return result('answer_nowcast_question', worker.message, {
    ...worker.payload,
    map: {
      artifactId: rendered.map.artifactId,
      label: rendered.map.name,
      reason: candidate.reason ?? null,
      leadMinutes: candidate.leadMinutes ?? null,
    },
  }, [ref], [rendered.preview, rendered.map])
}

async function generateNowcastText(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const analysis = requiredRefKind(ctx, args, 'nowcast_analysis_ref', ['nowcast_analysis']).value
  const facts = await deps.callWorker('generate_nowcast_forecast_text', { analysis }, ctx.signal)
  const text = typeof facts.payload.answer === 'string' ? facts.payload.answer.trim() : ''
  if (!text) throw new Error('短时临近预报（短临）领域服务未生成可用预报事实文本')
  const payload = { forecastText: text, facts: facts.payload }
  const ref: ValueRef = {
    refId: makeId('ref'),
    kind: 'nowcast_forecast_text',
    label: '短时临近预报（短临）预报文本',
    value: { text, facts: facts.payload },
  }
  return result('generate_nowcast_forecast_text', '短时临近预报（短临）领域文本已生成', payload, [ref])
}

async function renderNowcastRaster(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const candidate = refObject(requiredRefKind(ctx, args, 'nowcast_map_candidate_ref', ['nowcast_map_candidate']).value)
  const rendered = await renderCandidateArtifacts(ctx, deps, candidate, '短时临近预报（短临）降水栅格')
  return result(
    'render_nowcast_raster',
    rendered.worker.message,
    rendered.worker.payload,
    resultRefs('render_nowcast_raster', '短时临近预报（短临）栅格', rendered.worker.payload),
    [rendered.preview, rendered.map],
  )
}

async function renderCandidateArtifacts(
  ctx: ToolContext,
  deps: MeteorologyToolDeps,
  candidate: Record<string, unknown>,
  title: string,
  bbox?: number[],
) {
  const verifiedCandidate = await verifiedFileObject(ctx, {
    datasetId: candidate.datasetId,
    contentHash: candidate.contentHash,
    name: candidate.filename,
    relativePath: candidate.relativePath,
  }, 'nowcast_map_candidate_ref')
  const preview = artifactTarget(ctx, 'png', `${title}预览`)
  const map = artifactTarget(ctx, 'tif', title)
  const worker = await deps.callWorker('render_nowcast_raster', {
    file_relative_path: requiredCandidateText(verifiedCandidate, 'relativePath'),
    file_name: typeof verifiedCandidate.filename === 'string' ? verifiedCandidate.filename : undefined,
    variable: requiredCandidateText(candidate, 'variable'),
    bbox,
    output_relative_path: preview.relativePath,
    output_cog_relative_path: map.relativePath,
  }, ctx.signal)
  const metadata = {
    ...worker.payload,
    nowcastCandidate: candidate,
    nowcastMapReason: candidate.reason ?? null,
    nowcastLeadMinutes: candidate.leadMinutes ?? null,
  }
  mergeArtifactMetadata(preview, metadata, miniAppDisplay())
  mergeArtifactMetadata(
    map,
    metadata,
    rasterTileDisplay(map, worker.payload, map.name, 'meteorological-nowcast-precipitation'),
  )
  return { preview, map, worker }
}

async function verifiedSequencePayload(
  ctx: ToolContext,
  sequence: Record<string, unknown>,
): Promise<{ sequence: Record<string, unknown>; files: Record<string, unknown>[] }> {
  const files = await verifiedSequenceFiles(ctx, sequence)
  const datasets = Array.isArray(sequence.datasets) ? sequence.datasets.filter(isRecord) : []
  return {
    files,
    sequence: {
      ...sequence,
      datasets: datasets.map((dataset, index) => ({ ...dataset, ...files[index] })),
    },
  }
}

function optionalSequenceVariable(
  ctx: ToolContext,
  args: Record<string, unknown>,
  files: Record<string, unknown>[],
): { name: string; unit: string | null; datasetId: string; contentHash: string } | null {
  const refId = args.variable_ref
  if (typeof refId !== 'string' || !refId.trim()) return null
  const ref = requiredRefKind(ctx, args, 'variable_ref', ['meteorological_variable'])
  const lineage = requireMeteorologicalLineage(ref, 'variable_ref')
  if (!files.some(file => file.datasetId === lineage.datasetId && file.contentHash === lineage.contentHash)) {
    throw new Error('variable_ref 不属于短时临近预报文件集中的任一已校验数据集')
  }
  const value = refObject(ref.value)
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!name) throw new Error('variable_ref 不包含变量名')
  return { name, unit: valueRefUnit(ref), ...lineage }
}

function enrichSequencePayload(
  payload: Record<string, unknown>,
  files: Record<string, unknown>[],
): Record<string, unknown> {
  const datasets = Array.isArray(payload.datasets) ? payload.datasets.filter(isRecord) : []
  if (datasets.length !== files.length) throw new Error('短时临近预报 worker 返回的数据集数量与输入不一致')
  return {
    ...payload,
    datasets: datasets.map((dataset, index) => enrichDatasetOutput(dataset, files, `datasets[${index}]`)),
  }
}

function enrichDatasetOutput(
  output: Record<string, unknown>,
  files: Record<string, unknown>[],
  key: string,
): Record<string, unknown> {
  const datasetId = typeof output.datasetId === 'string' ? output.datasetId : ''
  const relativePath = typeof output.relativePath === 'string' ? output.relativePath : ''
  const file = files.find(candidate => (
    (datasetId && candidate.datasetId === datasetId)
    || (relativePath && candidate.relativePath === relativePath)
  ))
  if (!file) throw new Error(`${key} 不属于已校验的短时临近预报数据集`)
  return {
    ...output,
    datasetId: file.datasetId,
    contentHash: file.contentHash,
    filename: file.filename,
    relativePath: file.relativePath,
  }
}

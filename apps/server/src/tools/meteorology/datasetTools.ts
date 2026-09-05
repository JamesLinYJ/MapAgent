// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象数据集工具
//
//   文件:       datasetTools.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-31):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 模型气象解读改用 SDK 原生 JSON Schema 结构化输出。
// --------------------------------------------------------------------------

import { z } from 'zod'
import type { ToolContext, ToolDef, ToolResult, ValueRef } from '../../framework/types.js'
import { geoJsonSpatialMetadata } from '../../gis/geojsonCrs.js'
import { makeId } from '../../utils/ids.js'
import type { MeteorologyWorkerToolName } from './meteorologyWorkerClient.js'
import {
  refParameter,
  textParameter,
  tool,
  type MeteorologyToolDeps,
  withMeteorologyDeps,
} from './toolDefinition.js'
import {
  artifactTarget,
  assertSuffix,
  convertMeteorologicalUnitValue,
  datasetFileFromArgs,
  geoJsonDisplay,
  isRecord,
  mergeArtifactMetadata,
  meteorologicalLineageMetadata,
  miniAppDisplay,
  NETCDF_SUFFIXES,
  refObject,
  requireMatchingMeteorologicalLineage,
  requireMatchingMeteorologicalVariable,
  requiredRefKind,
  rasterTileDisplay,
  result,
  resultRefs,
  valueRefUnit,
  verifiedDatasetValue,
  writeJsonArtifact,
  type MeteorologicalDatasetLineage,
} from './toolRuntime.js'

const meteorologicalInterpretationSchema = z.object({
  reportText: z.string().min(20),
  summary: z.string().min(1),
  keyFindings: z.array(z.string()),
  riskSignals: z.array(z.string()),
  methodNotes: z.array(z.string()),
  recommendedNextSteps: z.array(z.string()),
})

export function createDatasetMeteorologyTools(deps: MeteorologyToolDeps): ToolDef[] {
  return [
    tool('meteorological_inspect', '检查气象数据集', '检查变量、维度、时间、层级和地图能力；未提供参数时使用当前 thread 最新上传的数据集', {
      dataset_ref: refParameter('气象文件引用', ['meteorological_file', 'meteorological_dataset']),
      dataset_id: textParameter('气象数据集 ID，latest_upload 表示当前 thread 最新上传'),
      filename: textParameter('气象数据文件名'),
    }, withMeteorologyDeps(deps, inspectDataset)),
    tool('interpret_meteorological_dataset', '解读气象数据集', '保存经过结构化校验的模型气象解读', {
      dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
    }, interpretDataset, ['dataset_ref']),
    workerDatasetTool(deps, 'meteorological_render', '渲染气象栅格', '生成气象变量 COG 地图与 PNG 预览', 'raster', {
      dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
      variable_ref: refParameter('变量引用', ['meteorological_variable']),
      time_index_ref: refParameter('时间索引引用', ['meteorological_time_index']),
      level_index_ref: refParameter('层级索引引用', ['meteorological_level_index']),
      bbox_ref: refParameter('范围引用', ['bbox']),
    }, ['dataset_ref', 'variable_ref']),
    workerDatasetTool(deps, 'meteorological_stats', '气象统计', '计算变量统计值', null, {
      dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
      variable_ref: refParameter('变量引用', ['meteorological_variable']),
      time_index_ref: refParameter('时间索引引用', ['meteorological_time_index']),
      level_index_ref: refParameter('层级索引引用', ['meteorological_level_index']),
      bbox_ref: refParameter('范围引用', ['bbox']),
    }, ['dataset_ref', 'variable_ref']),
    workerDatasetTool(deps, 'meteorological_threshold', '气象阈值区域', '计算超过阈值的区域', 'geojson', {
      dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
      variable_ref: refParameter('变量引用', ['meteorological_variable']),
      threshold_ref: refParameter('阈值引用', ['meteorological_threshold']),
      time_index_ref: refParameter('时间索引引用', ['meteorological_time_index']),
      level_index_ref: refParameter('层级索引引用', ['meteorological_level_index']),
      bbox_ref: refParameter('范围引用', ['bbox']),
      operator: textParameter('比较运算符'),
    }, ['dataset_ref', 'variable_ref', 'threshold_ref']),
    workerDatasetTool(deps, 'meteorological_contour', '气象等值线', '生成气象变量等值线', 'geojson', {
      dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
      variable_ref: refParameter('变量引用', ['meteorological_variable']),
      levels_ref: refParameter('等值线层级引用', ['meteorological_contour_levels']),
      time_index_ref: refParameter('时间索引引用', ['meteorological_time_index']),
      level_index_ref: refParameter('层级索引引用', ['meteorological_level_index']),
      bbox_ref: refParameter('范围引用', ['bbox']),
    }, ['dataset_ref', 'variable_ref']),
    tool('meteorological_report', '生成气象报告', '使用显式模型解读引用生成 DOCX 报告', {
      dataset_ref: refParameter('数据集引用', ['meteorological_dataset']),
      interpretation_ref: refParameter('模型解读引用', ['meteorological_interpretation']),
    }, withMeteorologyDeps(deps, generateReport), ['dataset_ref', 'interpretation_ref'], {
      isReadOnly: false,
    }),
  ]
}

function workerDatasetTool(
  deps: MeteorologyToolDeps,
  name: MeteorologyWorkerToolName,
  label: string,
  description: string,
  artifactType: 'raster' | 'geojson' | null,
  properties: Record<string, unknown>,
  required = ['dataset_ref'],
): ToolDef {
  return tool(name, label, description, properties, async (args, ctx) => {
    const file = await datasetFileFromArgs(ctx, args, 'dataset_ref', ['meteorological_dataset'])
    const variableRef = requiredDatasetAffinityRef(ctx, args, 'variable_ref', ['meteorological_variable'], file.lineage)
    const variable = refObject(variableRef.value)
    const variableName = typeof variable.name === 'string' ? variable.name.trim() : ''
    if (!variableName) throw new Error('variable_ref 不包含变量名')
    const variableUnit = valueRefUnit(variableRef)
    const timeRef = optionalDatasetAffinityRef(ctx, args, 'time_index_ref', ['meteorological_time_index'], file.lineage)
    const levelRef = optionalDatasetAffinityRef(ctx, args, 'level_index_ref', ['meteorological_level_index'], file.lineage)
    const bboxRef = optionalDatasetAffinityRef(ctx, args, 'bbox_ref', ['bbox'], file.lineage)
    const thresholdRef = optionalDatasetAffinityRef(ctx, args, 'threshold_ref', ['meteorological_threshold'], file.lineage)
    const levelsRef = optionalDatasetAffinityRef(ctx, args, 'levels_ref', ['meteorological_contour_levels'], file.lineage)
    const workerArgs: Record<string, unknown> = {
      file_relative_path: file.relativePath,
      file_name: file.name,
      variable: variableName,
      time_index: timeRef?.value,
      level_index: levelRef?.value,
      bbox: bboxRef?.value,
      threshold: thresholdRef ? convertedScalarRefValue(thresholdRef, variableRef, 'threshold_ref') : undefined,
      levels: levelsRef ? convertedLevelsRefValue(levelsRef, variableRef, 'levels_ref') : undefined,
      operator: typeof args.operator === 'string' ? args.operator : undefined,
    }
    let artifact = null
    let previewArtifact = null
    if (artifactType === 'raster') {
      previewArtifact = artifactTarget(ctx, 'png', `${file.name} 栅格预览`)
      artifact = artifactTarget(ctx, 'tif', `${file.name} 科学栅格`)
      workerArgs.output_relative_path = previewArtifact.relativePath
      workerArgs.output_cog_relative_path = artifact.relativePath
    }
    const worker = await deps.callWorker(name, workerArgs, ctx.signal)
    const workerVariable = typeof worker.payload.variable === 'string' ? worker.payload.variable.trim() : ''
    if (workerVariable && workerVariable !== variableName) {
      throw new Error(`气象 worker 返回变量 ${workerVariable}，与 variable_ref ${variableName} 不匹配`)
    }
    const workerUnit = typeof worker.payload.unit === 'string' ? worker.payload.unit.trim() : ''
    if (workerUnit && variableUnit) {
      convertMeteorologicalUnitValue(0, workerUnit, variableUnit, 'worker result')
    }
    if (artifactType === 'raster' && artifact && previewArtifact) {
      mergeArtifactMetadata(previewArtifact, worker.payload, miniAppDisplay())
      mergeArtifactMetadata(artifact, worker.payload, rasterTileDisplay(artifact, worker.payload))
    }
    if (artifactType === 'geojson') {
      artifact = artifactTarget(ctx, 'geojson', `${file.name} ${label}`)
      const canonical = await writeJsonArtifact(deps, artifact.relativePath, worker.payload)
      const canonicalPayload = canonical.entity as unknown as Record<string, unknown>
      const features = canonical.entity.type === 'FeatureCollection' ? canonical.entity.features : [canonical.entity]
      if (features.length > 0) {
        mergeArtifactMetadata(
          artifact,
          { ...worker.payload, ...geoJsonSpatialMetadata(canonical) },
          geoJsonDisplay(artifact, canonicalPayload, name === 'meteorological_contour' ? 'line' : 'polygon', {
            bounds: canonical.bounds,
            coordinateCrs: canonical.crs,
            featureCount: canonical.featureCount,
            sizeBytes: canonical.sizeBytes,
          }),
        )
      } else {
        mergeArtifactMetadata(artifact, { ...worker.payload, ...geoJsonSpatialMetadata(canonical) })
      }
    }
    const refs = resultRefs(name, label, worker.payload, file.lineage, variableName)
    const artifacts = [previewArtifact, artifact].filter((item): item is NonNullable<typeof item> => item !== null)
    return result(name, worker.message, worker.payload, refs, artifacts)
  }, required)
}

async function inspectDataset(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const file = await datasetFileFromArgs(ctx, args, 'dataset_ref', ['meteorological_file', 'meteorological_dataset'])
  const worker = await deps.callWorker(
    'meteorological_inspect',
    { file_relative_path: file.relativePath, file_name: file.name },
    ctx.signal,
  )
  const variables = Array.isArray(worker.payload.variables) ? worker.payload.variables.filter(isRecord) : []
  const lineageMetadata = meteorologicalLineageMetadata(file.lineage)
  const refs: ValueRef[] = [{
    refId: makeId('ref'), kind: 'meteorological_dataset', label: file.name,
    value: {
      datasetId: file.lineage.datasetId,
      contentHash: file.lineage.contentHash,
      name: file.name,
      relativePath: file.relativePath,
      metadata: worker.payload,
    },
    metadata: lineageMetadata,
  }]
  for (const variable of variables) {
    const variableName = String(variable.name ?? '').trim()
    if (!variableName) continue
    const unit = typeof variable.unit === 'string' && variable.unit.trim()
      ? variable.unit.trim()
      : typeof variable.units === 'string' && variable.units.trim() ? variable.units.trim() : null
    refs.push({
      refId: makeId('ref'), kind: 'meteorological_variable',
      label: `${file.name} / ${variableName}`,
      value: {
        datasetId: file.lineage.datasetId,
        contentHash: file.lineage.contentHash,
        name: variableName,
        datasetRelativePath: file.relativePath,
        metadata: variable,
      },
      unit,
      metadata: meteorologicalLineageMetadata(file.lineage, variableName),
    })
  }
  if (Array.isArray(worker.payload.bounds)) {
    refs.push({
      refId: makeId('ref'), kind: 'bbox', label: `${file.name} 数据范围`, value: worker.payload.bounds,
      metadata: lineageMetadata,
    })
  }
  const times = Array.isArray(worker.payload.times) ? worker.payload.times : []
  times.forEach((time, index) => {
    refs.push({
      refId: makeId('ref'), kind: 'meteorological_time_index', label: `${file.name} / ${String(time)}`, value: index,
      metadata: lineageMetadata,
    })
  })
  const levels = Array.isArray(worker.payload.levels) ? worker.payload.levels : []
  levels.forEach((level, index) => {
    refs.push({
      refId: makeId('ref'), kind: 'meteorological_level_index', label: `${file.name} / ${String(level)}`, value: index,
      metadata: lineageMetadata,
    })
  })
  return result('meteorological_inspect', worker.message, worker.payload, refs)
}

async function interpretDataset(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const datasetRef = requiredRefKind(ctx, args, 'dataset_ref', ['meteorological_dataset'])
  const dataset = await verifiedDatasetValue(ctx, datasetRef)
  const source = isRecord(datasetRef.value) ? datasetRef.value : {}
  const structured = await ctx.invokeStructuredModel(
    `仅根据以下气象数据 metadata 生成气象解读，不得补充 metadata 中不存在的观测事实：\n${JSON.stringify(source.metadata ?? {})}`,
    meteorologicalInterpretationSchema,
    { schemaVersion: 'meteorological_interpretation_v1' },
  )
  const text = structured.reportText.trim()
  const ref: ValueRef = {
    refId: makeId('ref'), kind: 'meteorological_interpretation', label: `${dataset.name} 模型解读`,
    value: {
      datasetId: dataset.lineage.datasetId,
      contentHash: dataset.lineage.contentHash,
      datasetRelativePath: dataset.relativePath,
      text,
      structured,
    },
    metadata: meteorologicalLineageMetadata(dataset.lineage),
  }
  return result('interpret_meteorological_dataset', '模型气象解读已通过校验', structured, [ref])
}

async function generateReport(args: Record<string, unknown>, ctx: ToolContext, deps: MeteorologyToolDeps): Promise<ToolResult> {
  const dataset = await verifiedDatasetValue(ctx, requiredRefKind(ctx, args, 'dataset_ref', ['meteorological_dataset']))
  assertSuffix(dataset.name, NETCDF_SUFFIXES, '短时强降水风险图数据')
  const interpretation = requiredRefKind(ctx, args, 'interpretation_ref', ['meteorological_interpretation'])
  requireMatchingMeteorologicalLineage(interpretation, dataset.lineage, 'interpretation_ref')
  const source = isRecord(interpretation.value) ? interpretation.value : {}
  const text = typeof source.text === 'string' ? source.text : ''
  if (!text) throw new Error('interpretation_ref 不包含模型解读正文')
  const artifact = artifactTarget(ctx, 'docx', `${dataset.name} 气象分析报告`)
  const worker = await deps.callWorker('meteorological_report', {
    file_relative_path: dataset.relativePath,
    file_name: dataset.name,
    interpretation_text: text,
    output_relative_path: artifact.relativePath,
  }, ctx.signal)
  mergeArtifactMetadata(artifact, {
    ...worker.payload,
  })
  return result('meteorological_report', worker.message, worker.payload, [], [artifact])
}

function optionalDatasetAffinityRef(
  ctx: ToolContext,
  args: Record<string, unknown>,
  key: string,
  kinds: string[],
  lineage: MeteorologicalDatasetLineage,
): ValueRef | undefined {
  const refId = args[key]
  if (typeof refId !== 'string' || !refId.trim()) return undefined
  return requireMatchingMeteorologicalLineage(requiredRefKind(ctx, args, key, kinds), lineage, key)
}

function requiredDatasetAffinityRef(
  ctx: ToolContext,
  args: Record<string, unknown>,
  key: string,
  kinds: string[],
  lineage: MeteorologicalDatasetLineage,
): ValueRef {
  const ref = optionalDatasetAffinityRef(ctx, args, key, kinds, lineage)
  if (!ref) throw new Error(`${key} 不能为空`)
  return ref
}

function convertedScalarRefValue(ref: ValueRef, variableRef: ValueRef, key: string): number {
  const variable = refObject(variableRef.value)
  const variableName = typeof variable.name === 'string' ? variable.name.trim() : ''
  requireMatchingMeteorologicalVariable(ref, variableName, key)
  if (typeof ref.value !== 'number' || !Number.isFinite(ref.value)) throw new Error(`${key} 不包含有限数值`)
  return convertMeteorologicalUnitValue(ref.value, valueRefUnit(ref), valueRefUnit(variableRef), key)
}

function convertedLevelsRefValue(ref: ValueRef, variableRef: ValueRef, key: string): number[] {
  const variable = refObject(variableRef.value)
  const variableName = typeof variable.name === 'string' ? variable.name.trim() : ''
  requireMatchingMeteorologicalVariable(ref, variableName, key)
  if (!Array.isArray(ref.value) || !ref.value.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error(`${key} 不包含有限数值数组`)
  }
  return ref.value.map(value => convertMeteorologicalUnitValue(value, valueRefUnit(ref), valueRefUnit(variableRef), key))
}

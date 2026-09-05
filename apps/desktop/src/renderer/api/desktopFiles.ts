// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面原生文件选择门面
//
//   文件:       desktopFiles.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { DesktopFileSelectionHandle } from '../../contracts/desktopIpc'
import { requireDesktopBridge } from './transport'

const STAGEABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const LAYER_FILTERS = [{
  name: 'GeoJSON 图层',
  extensions: ['geojson', 'json'],
}] as const

const AUTOMATION_FILTERS = [{
  name: '自动化流程 JSON',
  extensions: ['json'],
}] as const

/**
 * 选择待上传文件。Main 拥有原生对话框、绝对路径和文件句柄，
 * Renderer 只接收可展示元数据与一次性不透明句柄。
 */
export function selectDesktopUploadFiles(
  kind: 'files' | 'folder',
): Promise<DesktopFileSelectionHandle[]> {
  return requireDesktopBridge().files.select({
    kind,
    multiple: kind === 'files',
    filters: [],
  })
}

export async function selectDesktopUploadFile(): Promise<DesktopFileSelectionHandle | null> {
  const [file] = await requireDesktopBridge().files.select({
    kind: 'files',
    multiple: false,
    filters: [],
  })
  return file ?? null
}

/**
 * 粘贴图片和地图截图只把二进制交给 Main。Main 校验内容、创建临时文件并
 * 返回一次性句柄；Renderer 从不接触宿主绝对路径，也不生成 Base64。
 */
export async function stageDesktopImageBlob(
  blob: Blob,
  suggestedName = `pasted-image-${Date.now()}.png`,
): Promise<DesktopFileSelectionHandle> {
  const mediaType = blob.type.toLowerCase()
  if (!STAGEABLE_IMAGE_TYPES.has(mediaType)) {
    throw new Error(`暂不支持粘贴 ${blob.type || '未知类型'} 图片。`)
  }
  const bytes = await blob.arrayBuffer()
  return requireDesktopBridge().files.stageImage({
    name: suggestedName,
    mediaType: mediaType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
    bytes,
  })
}

export async function releaseDesktopFileHandle(handleId: string): Promise<void> {
  await requireDesktopBridge().files.release({ handleId })
}

export async function selectDesktopLayerFile(): Promise<DesktopFileSelectionHandle | null> {
  const [file] = await requireDesktopBridge().files.select({
    kind: 'files',
    multiple: false,
    filters: LAYER_FILTERS.map(filter => ({
      name: filter.name,
      extensions: [...filter.extensions],
    })),
  })
  return file ?? null
}

export async function selectDesktopAutomationDraft(): Promise<{
  file: DesktopFileSelectionHandle
  text: string
} | null> {
  const [file] = await requireDesktopBridge().files.select({
    kind: 'files',
    multiple: false,
    filters: AUTOMATION_FILTERS.map(filter => ({
      name: filter.name,
      extensions: [...filter.extensions],
    })),
  })
  if (!file) return null
  const result = await requireDesktopBridge().files.readText({
    handleId: file.handleId,
    expectedName: file.name,
    purpose: 'automation-draft-import',
  })
  return { file, text: result.text }
}

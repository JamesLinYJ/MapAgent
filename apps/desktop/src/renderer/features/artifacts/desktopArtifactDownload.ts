// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面 Artifact 受控下载适配器
//
//   文件:       desktopArtifactDownload.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { requestDesktopDownload, requestDesktopOpen } from '../../api/client'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

export interface DesktopDownloadArtifact {
  artifactId?: string | null
  artifactType?: string | null
  name?: string | null
  uri?: string | null
}

/**
 * Renderer 只提交服务器相对资源 URI 和建议文件名；认证、保存路径选择与文件
 * 写入全部留在 Electron Main。最终路径不会返回 Renderer。
 */
export function requestArtifactDownload(artifact: DesktopDownloadArtifact) {
  const uri = artifact.uri?.trim()
  if (!uri) throw new Error('当前结果没有可用的下载资源。')
  return requestDesktopDownload(uri, suggestedArtifactName(artifact))
}

export function requestArtifactGeoJsonDownload(
  artifact: Pick<DesktopDownloadArtifact, 'artifactId' | 'name'>,
) {
  const artifactId = artifact.artifactId?.trim()
  if (!artifactId) throw new Error('当前结果缺少 Artifact 标识，无法下载 GeoJSON。')
  return requestDesktopDownload(
    `/api/v1/results/${encodeURIComponent(artifactId)}/geojson`,
    ensureExtension(artifact.name?.trim() || artifactId, '.geojson'),
  )
}

/** 将已授权 Artifact 下载到 Main 管理的临时目录，并用系统默认应用打开。 */
export function requestArtifactOpen(artifact: DesktopDownloadArtifact) {
  const path = artifact.artifactType === 'geojson'
    ? geoJsonResourcePath(artifact)
    : artifact.uri?.trim()
  if (!path) throw new Error('当前结果没有可用的文件资源。')
  return requestDesktopOpen(path, suggestedArtifactName(artifact))
}

function suggestedArtifactName(artifact: DesktopDownloadArtifact): string {
  const stem = artifact.name?.trim()
    || artifact.artifactId?.trim()
    || `${PRODUCT_CODENAME}-结果`
  const extension = extensionForArtifactType(artifact.artifactType)
  return extension ? ensureExtension(stem, extension) : stem
}

function ensureExtension(value: string, extension: string): string {
  return value.toLocaleLowerCase('en-US').endsWith(extension)
    ? value
    : `${value}${extension}`
}

function extensionForArtifactType(artifactType?: string | null): string | null {
  return ({
    audio_mp3: '.mp3',
    chart_png: '.png',
    csv: '.csv',
    docx: '.docx',
    geojson: '.geojson',
    npz: '.npz',
    pdf: '.pdf',
    raster_png: '.png',
    table: '.csv',
    xlsx: '.xlsx',
  } as Record<string, string>)[artifactType ?? ''] ?? null
}

function geoJsonResourcePath(
  artifact: Pick<DesktopDownloadArtifact, 'artifactId'>,
): string | null {
  const artifactId = artifact.artifactId?.trim()
  return artifactId
    ? `/api/v1/results/${encodeURIComponent(artifactId)}/geojson`
    : null
}

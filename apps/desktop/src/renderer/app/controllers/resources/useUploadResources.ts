// +-------------------------------------------------------------------------
//
//   地理智能平台 - 上传资源控制器
//
//   文件:       useUploadResources.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { startTransition, useCallback, useEffect } from 'react'
import {
  runAttachmentInputSchema,
  type MapScreenshotContext,
  type RunAttachmentInput,
  type SessionRecord,
} from '@geo-agent-platform/shared-types'
import type { DesktopFileSelectionHandle } from '../../../../contracts/desktopIpc'
import {
  deleteAnyFile,
  getSession,
  listAllFiles,
  uploadAnyFile,
  uploadLayer,
  uploadMeteorologicalDataset,
} from '../../../api/client'
import {
  classifyUploadFile,
  formatFileSize,
  getUploadRelativePath,
  makeUploadReferenceId,
  upsertUploadReference,
} from '../../derivedState'
import { formatUiError, reportNonBlockingError } from '../../bootstrap'
import { useUploadStore } from '../../stores/uploadStore'
import type { UploadReference } from '../../types'

interface UploadResourcesOptions {
  currentThreadId?: string | null
  ensureActiveThread: (title: string) => Promise<string>
  onSessionRecord: (session: SessionRecord) => void
  onShowSources: () => void
  refreshLayers: (sessionId?: string | null, threadId?: string | null) => Promise<unknown>
  session?: SessionRecord
  setUiError: (error?: string) => void
}

/** 文件、目录和数据集上传生命周期。 */
export function useUploadResources({
  currentThreadId,
  ensureActiveThread,
  onSessionRecord,
  onShowSources,
  refreshLayers,
  session,
  setUiError,
}: UploadResourcesOptions) {
  const uploadedLayerName = useUploadStore(state => state.uploadedLayerName)
  const uploadReferences = useUploadStore(state => state.references)
  const allFiles = useUploadStore(state => state.files)
  const isFileSubmitting = useUploadStore(state => state.isFileSubmitting)
  const setUploadedLayerName = useUploadStore(state => state.setUploadedLayerName)
  const setUploadReferences = useUploadStore(state => state.setReferences)
  const setAllFiles = useUploadStore(state => state.setFiles)
  const setIsFileSubmitting = useUploadStore(state => state.setIsFileSubmitting)
  const clearUploads = useUploadStore(state => state.clear)

  const refreshAllFiles = useCallback(async (threadId?: string | null) => {
    const targetThreadId = threadId || currentThreadId
    if (!targetThreadId) {
      setAllFiles([])
      return
    }
    try {
      const data = await listAllFiles(targetThreadId)
      setAllFiles(data.files)
    } catch (error) {
      reportNonBlockingError('refreshAllFiles', error)
    }
  }, [currentThreadId, setAllFiles])

  const uploadOneFile = useCallback(async (
    file: DesktopFileSelectionHandle,
    explicitThreadId: string,
  ) => {
    if (!session) throw new Error('当前会话还没有初始化，暂时不能上传文件。')
    const kind = classifyUploadFile(file)
    if (!kind) throw new Error(`不支持的文件类型：${file.name}`)
    const relativePath = getUploadRelativePath(file)
    const referenceId = makeUploadReferenceId(kind, relativePath, file)
    const baseReference: UploadReference = {
      id: referenceId,
      kind,
      name: file.name,
      relativePath,
      status: 'uploading',
      detail: `${formatFileSize(file.sizeBytes)} · 正在上传`,
      totalCount: 1,
      completedCount: 0,
      failedCount: 0,
      totalBytes: file.sizeBytes,
      progress: 0,
    }
    setUploadReferences(current => upsertUploadReference(current, baseReference))

    try {
      if (kind === 'meteorology') {
        const { dataset } = await uploadMeteorologicalDataset(session.id, file, explicitThreadId, relativePath)
        startTransition(() => {
          setUploadedLayerName(dataset.filename)
          setUploadReferences(current => upsertUploadReference(current, {
            ...baseReference,
            name: dataset.filename,
            status: dataset.status,
            detail: `${formatFileSize(dataset.sizeBytes)} · 气象数据`,
            completedCount: 1,
            progress: 1,
          }))
        })
        return kind
      }

      if (kind === 'file') {
        const requestId = `upload_${crypto.randomUUID().replaceAll('-', '')}`
        const uploaded = await uploadAnyFile(file, explicitThreadId, requestId, relativePath)
        startTransition(() => {
          setUploadedLayerName(uploaded.name)
          setUploadReferences(current => upsertUploadReference(current, {
            ...baseReference,
            status: 'ready',
            detail: `${formatFileSize(file.sizeBytes)} · 线程文件`,
            completedCount: 1,
            progress: 1,
          }))
        })
        return kind
      }

      const descriptor = await uploadLayer(session.id, file, explicitThreadId, relativePath)
      startTransition(() => {
        setUploadedLayerName(descriptor.name)
        setUploadReferences(current => upsertUploadReference(current, {
          ...baseReference,
          name: descriptor.name,
          status: 'ready',
          detail: `${descriptor.featureCount ?? 0} 个对象 · ${descriptor.geometryType}`,
          completedCount: 1,
          progress: 1,
        }))
      })
      return kind
    } catch (error) {
      setUploadReferences(current => upsertUploadReference(current, {
        ...baseReference,
        status: 'failed',
        detail: formatUiError(error, '上传失败'),
        completedCount: 1,
        failedCount: 1,
        progress: 1,
      }))
      throw error
    }
  }, [session, setUploadReferences, setUploadedLayerName])

  const uploadFiles = useCallback(async (files: DesktopFileSelectionHandle[]) => {
    if (!session) return
    const uploadable = files.filter(file => classifyUploadFile(file))
    const skippedCount = files.length - uploadable.length
    if (!uploadable.length) {
      setUiError('没有找到可上传的 GeoJSON、NetCDF、GRIB、GeoTIFF、HDF5 或雷达 bz2 文件。')
      return
    }

    let threadId: string
    try {
      threadId = await ensureActiveThread('文件上传')
    } catch (error) {
      setUiError(formatUiError(error, '上传前创建对话线程失败。'))
      return
    }

    setUiError(undefined)
    onShowSources()
    const batchReference = buildUploadBatchReference(uploadable)
    if (batchReference) setUploadReferences(current => upsertUploadReference(current, batchReference))

    let layerUploaded = false
    let meteorologyUploaded = false
    const failures: string[] = []
    let processedCount = 0
    let failedCount = 0
    for (const file of uploadable) {
      try {
        const kind = await uploadOneFile(file, threadId)
        layerUploaded ||= kind === 'layer'
        meteorologyUploaded ||= kind === 'meteorology'
      } catch (error) {
        failedCount += 1
        failures.push(`${getUploadRelativePath(file)}：${formatUiError(error, '上传失败')}`)
      } finally {
        processedCount += 1
        if (batchReference) {
          setUploadReferences(current => upsertUploadReference(current, {
            ...batchReference,
            status: processedCount === uploadable.length
              ? (failedCount === uploadable.length ? 'failed' : 'ready')
              : 'uploading',
            detail: uploadBatchDetail(
              processedCount,
              uploadable.length,
              failedCount,
              batchReference.totalBytes ?? 0,
            ),
            completedCount: processedCount,
            failedCount,
            progress: processedCount / uploadable.length,
          }))
        }
      }
    }

    if (layerUploaded || meteorologyUploaded) {
      try {
        const [sessionRecord] = await Promise.all([
          getSession(session.id),
          refreshLayers(session.id, threadId),
        ])
        startTransition(() => onSessionRecord(sessionRecord))
      } catch (error) {
        setUiError(formatUiError(error, '文件已上传，但数据源列表刷新失败，请手动刷新页面确认。'))
        return
      }
    }

    if (failures.length) {
      const more = failures.length > 3 ? `；另有 ${failures.length - 3} 个失败` : ''
      setUiError(`部分文件上传失败：${failures.slice(0, 3).join('；')}${more}`)
    } else if (skippedCount > 0) {
      setUiError(`已上传 ${uploadable.length} 个文件，跳过 ${skippedCount} 个不支持的文件。`)
    }
  }, [
    ensureActiveThread,
    onSessionRecord,
    onShowSources,
    refreshLayers,
    session,
    setUiError,
    setUploadReferences,
    uploadOneFile,
  ])

  const uploadFile = useCallback(async (file: DesktopFileSelectionHandle) => {
    setIsFileSubmitting(true)
    try {
      const threadId = await ensureActiveThread('文件上传')
      await uploadAnyFile(file, threadId, undefined, getUploadRelativePath(file))
      await refreshAllFiles(threadId)
    } catch (error) {
      setUiError(formatUiError(error, `上传 ${file.name} 失败`))
    } finally {
      setIsFileSubmitting(false)
    }
  }, [ensureActiveThread, refreshAllFiles, setIsFileSubmitting, setUiError])

  const uploadComposerAttachment = useCallback(async (
    file: DesktopFileSelectionHandle,
    kind: RunAttachmentInput['kind'],
    mapContext: MapScreenshotContext | null = null,
  ): Promise<RunAttachmentInput> => {
    if (!file.mediaType.startsWith('image/')) {
      throw new Error(`对话图片附件不接受 ${file.mediaType || '未知类型'}。`)
    }
    const threadId = await ensureActiveThread(kind === 'map_screenshot' ? '地图截图' : '图片附件')
    const referenceId = `attachment:${file.handleId}`
    const reference: UploadReference = {
      id: referenceId,
      kind: 'file',
      name: file.name,
      relativePath: file.name,
      status: 'uploading',
      detail: `${formatFileSize(file.sizeBytes)} · 正在附加`,
      totalCount: 1,
      completedCount: 0,
      failedCount: 0,
      totalBytes: file.sizeBytes,
      progress: 0,
    }
    setUploadReferences(current => upsertUploadReference(current, reference))
    try {
      const uploaded = await uploadAnyFile(
        file,
        threadId,
        `attachment_${crypto.randomUUID().replaceAll('-', '')}`,
        file.name,
      )
      const attachment = runAttachmentInputSchema.parse({
        fileId: uploaded.id,
        name: uploaded.name,
        mediaType: file.mediaType,
        kind,
        mapContext,
      })
      setUploadReferences(current => upsertUploadReference(current, {
        ...reference,
        status: 'ready',
        detail: `${formatFileSize(uploaded.sizeBytes)} · ${kind === 'map_screenshot' ? '地图截图' : '图片附件'}`,
        completedCount: 1,
        progress: 1,
      }))
      await refreshAllFiles(threadId)
      return attachment
    } catch (error) {
      setUploadReferences(current => upsertUploadReference(current, {
        ...reference,
        status: 'failed',
        detail: formatUiError(error, '图片附件上传失败'),
        completedCount: 1,
        failedCount: 1,
        progress: 1,
      }))
      throw error
    }
  }, [ensureActiveThread, refreshAllFiles, setUploadReferences])

  const removeFile = useCallback(async (fileId: string) => {
    try {
      setUiError(undefined)
      if (!currentThreadId) throw new Error('当前没有可操作的对话线程。')
      await deleteAnyFile(fileId, currentThreadId)
      await refreshAllFiles(currentThreadId)
    } catch (error) {
      setUiError(formatUiError(error, '删除文件失败'))
    }
  }, [currentThreadId, refreshAllFiles, setUiError])

  useEffect(() => {
    if (currentThreadId) void refreshAllFiles(currentThreadId)
  }, [currentThreadId, refreshAllFiles])

  return {
    allFiles,
    clearUploads,
    isFileSubmitting,
    removeFile,
    uploadedLayerName,
    uploadFile,
    uploadComposerAttachment,
    uploadFiles,
    uploadReferences,
  }
}

function buildUploadBatchReference(files: DesktopFileSelectionHandle[]): UploadReference | null {
  if (files.length <= 1) return null
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  const firstFile = files[0]
  if (!firstFile) return null
  const firstKind = classifyUploadFile(firstFile) ?? 'file'
  return {
    id: `batch:${files.length}:${files.map(file => `${getUploadRelativePath(file)}:${file.sizeBytes}`).join('|')}`,
    kind: firstKind,
    name: uploadBatchName(files),
    status: 'uploading',
    detail: uploadBatchDetail(0, files.length, 0, totalBytes),
    isAggregate: true,
    totalCount: files.length,
    completedCount: 0,
    failedCount: 0,
    totalBytes,
    progress: 0,
  }
}

function uploadBatchName(files: DesktopFileSelectionHandle[]): string {
  const roots = files
    .map(file => getUploadRelativePath(file).split(/[\\/]/).filter(Boolean)[0])
    .filter(Boolean)
  const sharedRoot = roots.length && roots.every(root => root === roots[0]) ? roots[0] : undefined
  return sharedRoot ? `${sharedRoot} 文件夹` : `${files.length} 个文件`
}

function uploadBatchDetail(done: number, total: number, failed: number, totalBytes: number): string {
  const failureText = failed > 0 ? ` · ${failed} 个失败` : ''
  return `${done}/${total} 个文件 · ${formatFileSize(totalBytes)}${failureText}`
}
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 上传资源控制器
//
//   文件:       useUploadResources.ts
// --------------------------------------------------------------------------

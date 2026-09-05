// +-------------------------------------------------------------------------
//
//   地理智能平台 - 托管图层资源控制器
//
//   文件:       useManagedLayerResources.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useCallback } from 'react'
import type { DesktopFileSelectionHandle } from '../../../../contracts/desktopIpc'
import {
  deleteLayer,
  importManagedLayer,
  listLayers,
  replaceManagedLayer,
  updateLayer,
} from '../../../api/client'
import { formatUiError } from '../../bootstrap'
import { useLayerStore } from '../../stores/layerStore'

interface ManagedLayerResourcesOptions {
  onShowSources: () => void
  setUiError: (error?: string) => void
}

/** 托管图层的数据访问与命令编排边界。 */
export function useManagedLayerResources({
  onShowSources,
  setUiError,
}: ManagedLayerResourcesOptions) {
  const layers = useLayerStore(state => state.layers)
  const setLayers = useLayerStore(state => state.setLayers)

  const refreshLayers = useCallback(async (
    sessionId?: string | null,
    threadId?: string | null,
  ) => {
    const nextLayers = await listLayers(sessionId, threadId)
    setLayers(nextLayers)
    return nextLayers
  }, [setLayers])

  const importLayer = useCallback(async (file: DesktopFileSelectionHandle) => {
    try {
      setUiError(undefined)
      onShowSources()
      await importManagedLayer(file)
      await refreshLayers()
    } catch (error) {
      setUiError(formatUiError(error, '图层导入没成功，请再试一次。'))
    }
  }, [onShowSources, refreshLayers, setUiError])

  const toggleLayerStatus = useCallback(async (layerKey: string, nextStatus: string) => {
    try {
      setUiError(undefined)
      await updateLayer(layerKey, { status: nextStatus })
      await refreshLayers()
    } catch (error) {
      setUiError(formatUiError(error, '图层状态更新失败，请再试一次。'))
    }
  }, [refreshLayers, setUiError])

  const replaceLayer = useCallback(async (
    layerKey: string,
    file: DesktopFileSelectionHandle,
  ) => {
    try {
      setUiError(undefined)
      onShowSources()
      await replaceManagedLayer(layerKey, file)
      await refreshLayers()
    } catch (error) {
      setUiError(formatUiError(error, '图层数据替换失败，请再试一次。'))
    }
  }, [onShowSources, refreshLayers, setUiError])

  const removeLayer = useCallback(async (layerKey: string) => {
    try {
      setUiError(undefined)
      await deleteLayer(layerKey)
      await refreshLayers()
    } catch (error) {
      setUiError(formatUiError(error, '图层删除失败，请再试一次。'))
    }
  }, [refreshLayers, setUiError])

  return {
    layers,
    refreshLayers,
    importLayer,
    toggleLayerStatus,
    replaceLayer,
    removeLayer,
  }
}
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 托管图层资源控制器
//
//   文件:       useManagedLayerResources.ts
// --------------------------------------------------------------------------

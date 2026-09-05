// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层管理偏好规则测试
//
//   文件:       layerManagerPreferences.test.ts
//
//   日期:       2026年07月01日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest'
import {
  readLayerManagerPreferences,
  reorderMapSceneLayers,
  sanitizeLayerManagerPreferences,
  writeLayerManagerPreferences,
  type LayerManagerPreferences,
} from '../features/layers/useLayerManager'

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

describe('layer manager preferences', () => {
  it('drops unknown panel and filter values when reading persisted state', () => {
    // 本地偏好只是工作区编辑态；读取时必须清洗，不能让旧值驱动不存在的 UI 视图。
    const preferences = sanitizeLayerManagerPreferences({
      activeView: 'legacyPanel',
      visibilityFilter: 'selectedOnly',
      groups: [{ id: 'group_1', name: '气象产品', memberIds: ['layer_1'], expanded: false }],
      overrides: {
        layer_1: { name: '雷达回波' },
        layer_2: 'bad',
      },
    })

    expect(preferences.activeView).toBe('drawOrder')
    expect(preferences.visibilityFilter).toBe('all')
    expect(preferences.groups).toEqual([{ id: 'group_1', name: '气象产品', memberIds: ['layer_1'], expanded: false }])
    expect(preferences.overrides.layer_1).toEqual({ name: '雷达回波' })
    expect(preferences.overrides.layer_2).toBeUndefined()
  })

  it('persists preferences by thread and run scoped storage key', () => {
    installWindowStorage()
    const preferences: LayerManagerPreferences = {
      activeView: 'sources',
      visibilityFilter: 'visible',
      groups: [],
      overrides: { layer_a: { name: '雷达回波' } },
    }

    writeLayerManagerPreferences('thread_1:run_1', preferences)
    writeLayerManagerPreferences('thread_1:run_2', { ...preferences, activeView: 'table' })

    expect(readLayerManagerPreferences('thread_1:run_1')).toMatchObject({
      activeView: 'sources',
      visibilityFilter: 'visible',
      overrides: { layer_a: { name: '雷达回波' } },
    })
    expect(readLayerManagerPreferences('thread_1:run_2').activeView).toBe('table')
  })

  it('reorders the canonical map scene rather than only moving a visual row', () => {
    const layers = ['radar', 'qpf', 'boundary'].map((mapLayerId, order) => ({
      mapLayerId,
      order,
      visible: true,
      opacity: 1,
      styleOverride: null,
      label: null,
      currentFrameId: null,
    }))

    expect(reorderMapSceneLayers(layers, 'boundary', 'radar')?.map(layer => ({
      id: layer.mapLayerId,
      order: layer.order,
    }))).toEqual([
      { id: 'boundary', order: 0 },
      { id: 'radar', order: 1 },
      { id: 'qpf', order: 2 },
    ])
    expect(reorderMapSceneLayers(layers, 'missing', 'radar')).toBeNull()
  })
})

function installWindowStorage() {
  const store = new Map<string, string>()
  const localStorage: Storage = {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key: string) {
      return store.get(key) ?? null
    },
    key(index: number) {
      return [...store.keys()][index] ?? null
    },
    removeItem(key: string) {
      store.delete(key)
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    },
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
  })
}

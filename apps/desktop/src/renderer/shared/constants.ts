// +-------------------------------------------------------------------------
//
//   地理智能平台 - 前端默认常量
//
//   文件:       constants.ts
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { BasemapDescriptor } from '@geo-agent-platform/shared-types'
import {
  PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME,
} from '@geo-agent-platform/shared-types/product-identity'

export interface DataReferenceSummary {
  id: string
  kind: 'layer' | 'file' | 'artifact' | 'meteorology'
  name: string
  status: string
  detail: string
  relativePath?: string
}

export const SAMPLES = [
  '帮我看看杭州今天短时强降水风险主要集中在哪些区',
  '把我上传的定量降水预报数据做成一张风险区划图',
  '基于现有雷达资料生成天气雷达组网拼图，并给我一个简短说明',
] as const

// 默认底图只在服务端底图列表尚未返回时兜底显示。桌面 Renderer 不直接访问公网，
// 瓦片统一经受控 API 协议交给服务端天地图网关，API KEY 不进入 Renderer。
export const DEFAULT_BASEMAP: BasemapDescriptor = {
  basemapKey: 'tianditu-vector',
  name: '天地图',
  provider: '国家地理信息公共服务平台',
  kind: 'raster',
  attribution: '© 天地图',
  tileUrls: [`${PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME}://api/api/v1/map/basemaps/tianditu-vector/tiles/vector/{z}/{x}/{y}`],
  labelTileUrls: [`${PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME}://api/api/v1/map/basemaps/tianditu-vector/tiles/labels/{z}/{x}/{y}`],
  // 目录加载前保持不可用，避免在服务端明确缺少 Key 时继续盲目请求瓦片。
  available: false,
  isDefault: true,
}

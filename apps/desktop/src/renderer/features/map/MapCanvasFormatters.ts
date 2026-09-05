// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图数值格式化
//
//   文件:       MapCanvasFormatters.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 地图渲染层和弹窗层共享的纯格式化逻辑放在这里，避免 engine 与 popup
// 因展示文案互相依赖。

export function formatDurationLabel(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} 分钟`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}

export function formatRouteDistance(distanceKm: number): string {
  return distanceKm >= 1 ? `${distanceKm.toFixed(1)} km` : `${(distanceKm * 1000).toFixed(0)} m`
}

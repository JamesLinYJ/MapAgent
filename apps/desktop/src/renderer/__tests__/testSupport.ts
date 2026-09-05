// +-------------------------------------------------------------------------
//
//   地理智能平台 - Renderer 测试辅助函数
//
//   文件:       testSupport.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export function requiredAt<T>(values: readonly T[], index: number, label = '测试数据'): T {
  const value = values[index]
  if (value === undefined) throw new Error(`${label} 缺少索引 ${index}`)
  return value
}

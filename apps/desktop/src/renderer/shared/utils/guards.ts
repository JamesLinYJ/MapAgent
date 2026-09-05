// +-------------------------------------------------------------------------
//
//   地理智能平台 - 共享类型守卫
//
//   文件:       guards.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// Type guard: checks if a value is a non-null, non-array object.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

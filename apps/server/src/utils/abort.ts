// +-------------------------------------------------------------------------
//
//   地理智能平台 - 中止信号工具
//
//   文件:       abort.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export function abortSignalWithTimeout(external: unknown, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return external instanceof AbortSignal
    ? AbortSignal.any([external, timeout])
    : timeout
}

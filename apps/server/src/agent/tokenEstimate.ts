// +-------------------------------------------------------------------------
//
//   地理智能平台 - 低成本多语言 Token 估算
//
//   文件:       tokenEstimate.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

/**
 * 在不把供应商 tokenizer 放进请求热路径的前提下，提供保守且稳定的预算估算。
 *
 * 英文/JSON 通常接近 4 个 ASCII 字符一个 token；CJK 字符通常接近一个
 * token，emoji 等四字节码点可能占用更多。旧的 `length / 4` 会把中文上下文
 * 低估约四倍，导致压缩过晚和上游 context overflow。
 */
export function estimateTextTokens(...texts: readonly string[]): number {
  let estimate = 0
  for (const text of texts) {
    for (let index = 0; index < text.length; index += 1) {
      const codePoint = text.codePointAt(index) ?? 0
      if (codePoint <= 0x7f) {
        estimate += 0.25
      } else if (codePoint <= 0x7ff) {
        estimate += 2 / 3
      } else if (codePoint <= 0xffff) {
        estimate += 1
      } else {
        estimate += 4 / 3
        index += 1
      }
    }
  }
  return Math.ceil(estimate)
}

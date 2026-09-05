// +-------------------------------------------------------------------------
//
//   地理智能平台 - 有界 HTTP 文本响应读取
//
//   文件:       boundedResponseBody.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

/**
 * 在分配完整字符串前按原始字节数硬限制响应体，避免被上游 Content-Length
 * 缺失或伪造时拖入无界内存分配。
 */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw responseLimitError(label, maxBytes)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel('response size limit exceeded')
        throw responseLimitError(label, maxBytes)
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function responseLimitError(label: string, maxBytes: number): Error {
  const mebibytes = Math.max(1, Math.floor(maxBytes / 1024 / 1024))
  return new Error(`${label}超过 ${mebibytes} MiB 安全上限。`)
}

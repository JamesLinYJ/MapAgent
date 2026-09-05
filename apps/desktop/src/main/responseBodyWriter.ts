// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web 响应文件流写入器
//
//   文件:       responseBodyWriter.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { open, rm } from 'node:fs/promises'

/** 将 Chromium Web Stream 顺序落盘；任何中途失败都会删除不完整文件。 */
export async function writeResponseBodyToFile(response: Response, filePath: string): Promise<void> {
  if (!response.body) throw new Error('服务响应缺少可写入的内容流。')
  const output = await open(filePath, 'w', 0o600)
  try {
    const reader = response.body.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      await output.write(chunk.value)
    }
    await output.sync()
    await output.close()
  } catch (error) {
    await output.close().catch(() => undefined)
    await rm(filePath, { force: true })
    throw error
  }
}

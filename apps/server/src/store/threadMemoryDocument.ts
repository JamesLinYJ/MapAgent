// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程记忆文档分区
//
//   文件:       threadMemoryDocument.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

const USER_NOTES_START = '<!-- user-notes:start -->'
const USER_NOTES_END = '<!-- user-notes:end -->'

export interface ThreadMemorySections {
  generatedContent: string
  pinnedContent: string
}

export function splitThreadMemoryDocument(content: string): ThreadMemorySections {
  const startIndex = content.indexOf(USER_NOTES_START)
  const endIndex = content.indexOf(USER_NOTES_END)
  if (startIndex < 0 || endIndex < startIndex) {
    return { generatedContent: content, pinnedContent: '' }
  }
  return {
    generatedContent: `${content.slice(0, startIndex)}${content.slice(endIndex + USER_NOTES_END.length)}`.trim(),
    pinnedContent: content.slice(startIndex + USER_NOTES_START.length, endIndex).trim(),
  }
}

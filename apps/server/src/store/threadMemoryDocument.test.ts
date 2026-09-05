// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程记忆文档分区测试
//
//   文件:       threadMemoryDocument.test.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { splitThreadMemoryDocument } from './threadMemoryDocument.js'

describe('threadMemoryDocument', () => {
  it('分离生成内容和用户固定区', () => {
    const result = splitThreadMemoryDocument([
      '# 摘要',
      '<!-- user-notes:start -->',
      '不要改变等值线单位。',
      '<!-- user-notes:end -->',
      '## 结论',
    ].join('\n'))

    expect(result.generatedContent).toBe('# 摘要\n\n## 结论')
    expect(result.pinnedContent).toBe('不要改变等值线单位。')
  })

  it('没有固定区时保留完整正文', () => {
    expect(splitThreadMemoryDocument('# 摘要')).toEqual({ generatedContent: '# 摘要', pinnedContent: '' })
  })
})

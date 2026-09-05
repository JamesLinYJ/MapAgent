// +-------------------------------------------------------------------------
//
//   地理智能平台 - 表单字段 (react-hook-form + zod)
//
//   文件:       FormField.tsx
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 统一 react-hook-form + Zod 表单基础设施。
// 错误文案中文化，不泄露内部栈。

import type { FieldError } from 'react-hook-form'

export function formatZodError(error: FieldError | undefined): string | null {
  if (!error) return null
  if (error.message) return error.message
  switch (error.type) {
    case 'required': return '此字段不能为空'
    case 'too_small': return `不能小于 ${error.types?.too_small}`
    case 'too_big': return '输入值超出范围'
    case 'invalid_type': return '输入类型不匹配'
    case 'invalid_string': return '输入格式不正确'
    default: return '输入无效'
  }
}

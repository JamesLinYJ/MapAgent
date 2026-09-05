// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型服务测试结果展示
//
//   文件:       providerTestPresentation.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { CustomProviderTestResult } from '@geo-agent-platform/shared-types'

export function providerTestNotice(result: CustomProviderTestResult): string {
  if (result.warning) {
    return `测试完成，但服务返回提醒：${result.warning} 这不会阻止保存。`
  }
  if (result.mode === 'models') {
    return `模型目录获取成功，共发现 ${result.models.length} 个模型，用时 ${Math.round(result.latencyMs)} 毫秒。`
  }
  if (result.mode === 'model_call') {
    return result.modelCallOk
      ? `模型调用成功，使用 ${result.testedModel ?? '默认模型'}，用时 ${Math.round(result.latencyMs)} 毫秒。`
      : '模型调用未完成；这不会阻止保存。'
  }
  return result.connectivityOk
    ? `连接成功，用时 ${Math.round(result.latencyMs)} 毫秒。`
    : '连接测试未通过；这不会阻止保存。'
}

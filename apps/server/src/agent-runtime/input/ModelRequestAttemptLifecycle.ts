// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型请求尝试生命周期
//
//   文件:       ModelRequestAttemptLifecycle.ts
//
//   日期:       2026年08月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Model,ModelRequest,ModelResponse } from '@openai/agents'
import type { ModelRequestRecord } from '@geo-agent-platform/shared-types/model-request'

/**
 * 一个开放尝试对应 SDK 的一次逻辑模型调用。供应商自动重试不会
 * 重新进入 callModelInputFilter，因此在供应商完整响应前保留已提交快照；
 * 完整响应后立即释放，下一个真实模型步骤必须创建新快照。
 */
export class ModelRequestAttemptLifecycle {
  private activeRecord: ModelRequestRecord | null = null

  current(): ModelRequestRecord | null {
    return this.activeRecord
  }

  open(record: ModelRequestRecord): void {
    if (this.activeRecord) {
      throw new Error(`模型请求尝试 '${this.activeRecord.requestId}' 尚未完成`)
    }
    this.activeRecord = record
  }

  complete(): void {
    if (!this.activeRecord) throw new Error('没有可完成的模型请求尝试')
    this.activeRecord = null
  }
}

/**
 * 只在供应商调用正常结束时确认尝试。失败时保留快照，使 SDK
 * 的下一次自动重试仍可以精确重放；不在这里自行决定是否重试。
 */
export function completeModelRequestAttemptOnSuccess(
  model: Model,
  lifecycle: ModelRequestAttemptLifecycle,
): Model {
  return {
    getResponse: async (request: ModelRequest): Promise<ModelResponse> => {
      const response = await model.getResponse(request)
      lifecycle.complete()
      return response
    },
    getStreamedResponse: request => completeStreamedResponse(model, request, lifecycle),
    getRetryAdvice: args => model.getRetryAdvice?.(args),
  }
}

async function* completeStreamedResponse(
  model: Model,
  request: ModelRequest,
  lifecycle: ModelRequestAttemptLifecycle,
): ReturnType<Model['getStreamedResponse']> {
  yield* model.getStreamedResponse(request)
  lifecycle.complete()
}

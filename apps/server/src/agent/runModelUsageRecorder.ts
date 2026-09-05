// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行模型用量记录器
//
//   文件:       runModelUsageRecorder.ts
//
//   日期:       2026年08月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
Model,
ModelRequest,
ModelResponse,
ResponseStreamEvent,
} from '@openai/agents'

import {
aggregateModelUsage,
mergeModelUsageStats,
type ModelUsageResponseLike,
} from '../model/modelUsage.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'

/**
 * 同一 SDK 执行树中 Runner 响应用量的唯一原子写入边界。
 *
 * 父 Runner 由 RuntimeSdkExecutor 消费 rawResponses；Agent-as-tool 的
 * 嵌套 Runner 不会把 rawResponses 合并进父结果，因此由下面的
 * ownNestedModel() 在嵌套模型边界记录。Handoff 仍在父 Runner 内运行，
 * 不得使用该包装器，否则会与父 rawResponses 重复。
 */
export class RunModelUsageRecorder {
  private readonly nestedModels = new WeakMap<Model, Model>()

  constructor(
    private readonly store: AgentRuntimeStore,
    private readonly runId: string,
  ) {}

  async recordResponses(responses: readonly ModelUsageResponseLike[]): Promise<void> {
    if (!responses.length) return
    const usage = aggregateModelUsage([...responses])
    await this.store.mutateRunState(this.runId, state => ({
      runtimeStats: mergeModelUsageStats(state.runtimeStats, usage),
    }))
  }

  /**
   * 嵌套 Agent-as-tool 的每个完整 provider 响应在模型边界立即入账。
   * 这不依赖嵌套 RunState 的私有序列化结构，审批恢复也只会记录
   * 恢复后真正新产生的响应。
   */
  ownNestedModel(model: Model): Model {
    const existing = this.nestedModels.get(model)
    if (existing) return existing
    const owned: Model = {
      getResponse: async (request: ModelRequest): Promise<ModelResponse> => {
        const response = await model.getResponse(request)
        await this.recordNestedResponse(response)
        return response
      },
      getStreamedResponse: request => this.recordCompletedStreamResponse(model, request),
      // 用量事实源写入失败不是 provider 网络错误，不得交给
      // provider 重试策略，否则可能已计费却因本地数据库故障再次调用模型。
      getRetryAdvice: args => args.error instanceof RunModelUsagePersistenceError
        ? undefined
        : model.getRetryAdvice?.(args),
    }
    this.nestedModels.set(model, owned)
    this.nestedModels.set(owned, owned)
    return owned
  }

  private async *recordCompletedStreamResponse(
    model: Model,
    request: ModelRequest,
  ): AsyncIterable<ResponseStreamEvent> {
    for await (const event of model.getStreamedResponse(request)) {
      // response_done 是 SDK Model 合约中“一次完整模型响应”的边界。
      // 必须先入账再向 Runner 交付，否则下游工具或投影抛错会
      // 提前关闭生成器，已发生的词元将永久漏记。
      if (event.type === 'response_done') {
        await this.recordNestedResponse(event.response)
      }
      yield event
    }
  }

  private async recordNestedResponse(response: SdkUsageResponse): Promise<void> {
    try {
      await this.recordResponses([usageResponseFromSdk(response)])
    } catch (error) {
      throw new RunModelUsagePersistenceError(this.runId, error)
    }
  }
}

class RunModelUsagePersistenceError extends Error {
  constructor(runId: string, cause: unknown) {
    super(`运行 '${runId}' 的嵌套模型响应已完成，但词元用量保存失败`, { cause })
    this.name = 'RunModelUsagePersistenceError'
  }
}

interface SdkUsageResponse {
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    inputTokensDetails?: Record<string, number> | Array<Record<string, number>> | null | undefined
  }
  rawUsage?: Record<string, unknown> | undefined
}

function usageResponseFromSdk(response: SdkUsageResponse): ModelUsageResponseLike {
  const inputTokensDetails = response.usage.inputTokensDetails
  const rawUsage = response.rawUsage
  return {
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      ...(inputTokensDetails === undefined ? {} : { inputTokensDetails }),
    },
    ...(rawUsage === undefined ? {} : { rawUsage }),
  }
}

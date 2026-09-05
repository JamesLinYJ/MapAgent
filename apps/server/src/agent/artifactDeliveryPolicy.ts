// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent Artifact 交付授权策略
//
//   文件:       artifactDeliveryPolicy.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentRuntimeStore } from '../store/runtimePorts.js'

/**
 * 最终交付只接受当前 run 在创建时可见、仍有 PostgreSQL 归属且内容可读取的
 * 同线程 Artifact。不存在与越权使用同一外部错误，避免泄露其它线程资源。
 */
export async function assertArtifactDeliveryIsVisible(
  store: AgentRuntimeStore,
  runId: string,
  artifactIds: readonly string[],
): Promise<void> {
  if (!artifactIds.length) return
  const requested = [...new Set(artifactIds)]
  const resolved = await store.listArtifactsVisibleToRun(runId, { artifactIds: requested })
  const byId = new Map(resolved.map(resource => [resource.artifactId, resource]))
  const unauthorized = requested.filter(artifactId => !byId.has(artifactId))
  if (unauthorized.length) {
    throw new Error(`Agent 最终输出引用了当前线程不可用或未授权的 Artifact：${unauthorized.join('、')}`)
  }
  const unavailable = requested.flatMap(artifactId => {
    const resource = byId.get(artifactId)
    return resource && resource.availability !== 'available'
      ? [`${artifactId}（${resource.unavailableReason ?? resource.availability}）`]
      : []
  })
  if (unavailable.length) {
    throw new Error(`Agent 最终输出引用的 Artifact 内容不可核验：${unavailable.join('、')}`)
  }
}

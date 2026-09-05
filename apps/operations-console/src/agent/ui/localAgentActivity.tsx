// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 活动指示器
//
//   文件:       localAgentActivity.tsx
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useEffect, useState } from 'react'

import { Spinner } from '@inkjs/ui'
import { Box, Text } from 'ink'

import { consolePalette } from '../../localConsoleTheme.js'
import type { LocalAgentSessionSnapshot } from '../application/localAgentSession.js'

export interface AgentActivityDescriptor {
  key: string
  label: string
  detail: string
  startedAt: string | null
  color: string
}

/**
 * 活动文案只投影服务端已有状态，不推测未发生的 Agent 步骤。
 * 动画属于终端反馈层，不反向写入运行事实。
 */
export function describeAgentActivity(
  snapshot: LocalAgentSessionSnapshot,
  busy: boolean,
): AgentActivityDescriptor | null {
  if (snapshot.connection !== 'online') {
    return {
      key: `connection:${snapshot.connection}`,
      label: '正在恢复连接',
      detail: snapshot.connectionMessage,
      startedAt: null,
      color: consolePalette.warning,
    }
  }
  if (busy) {
    return {
      key: 'submit',
      label: '正在提交问题',
      detail: '安全发送到本机 API',
      startedAt: null,
      color: consolePalette.info,
    }
  }

  const run = snapshot.run
  if (!run || !['queued', 'running'].includes(run.status)) return null

  const latestRunningItem = [...snapshot.items].reverse().find(item => item.status === 'running')
  if (latestRunningItem?.itemType === 'function_call') {
    const registered = snapshot.bootstrap?.tools.find(tool => tool.name === latestRunningItem.name)
    return {
      key: `tool:${latestRunningItem.callId}`,
      label: `正在调用 ${registered?.label ?? '工具'}`,
      detail: registered && latestRunningItem.name
        ? latestRunningItem.name
        : '等待工具返回真实结果',
      startedAt: run.createdAt,
      color: consolePalette.healthy,
    }
  }
  if (latestRunningItem?.itemType === 'reasoning') {
    return {
      key: `reasoning:${latestRunningItem.itemId}`,
      label: '正在推理',
      detail: '核验上下文、数据与工具证据',
      startedAt: run.createdAt,
      color: consolePalette.reasoning,
    }
  }
  if (latestRunningItem?.itemType === 'message' && latestRunningItem.role === 'assistant') {
    return {
      key: `answer:${latestRunningItem.itemId}`,
      label: '正在组织回答',
      detail: '把分析结果整理为可读结论',
      startedAt: run.createdAt,
      color: consolePalette.focus,
    }
  }

  const activeSubAgent = run.state.subAgents.find(agent => agent.status === 'running')
  if (activeSubAgent) {
    return {
      key: `subagent:${activeSubAgent.agentId}`,
      label: '子智能体协作中',
      detail: activeSubAgent.name,
      startedAt: run.createdAt,
      color: consolePalette.accent,
    }
  }

  return {
    key: `run:${run.id}:${run.status}`,
    label: run.status === 'queued' ? '等待模型响应' : '正在推进任务',
    detail: run.status === 'queued' ? '运行已进入安全队列' : 'Agent 正在选择下一步动作',
    startedAt: run.createdAt,
    color: run.status === 'queued' ? consolePalette.info : consolePalette.warning,
  }
}

export function AgentActivityIndicator({
  activity,
  animationsEnabled,
  compact,
}: {
  activity: AgentActivityDescriptor
  animationsEnabled: boolean
  compact: boolean
}) {
  const elapsedSeconds = useActivityElapsedSeconds(activity, animationsEnabled)
  return (
    <Box minWidth={0}>
      {animationsEnabled
        ? <Spinner type="aesthetic" />
        : <Text bold color={activity.color}>◐</Text>}
      <Text bold color={activity.color}> {activity.label}</Text>
      {!compact && <Text color={consolePalette.muted}> · {activity.detail}</Text>}
      {animationsEnabled && elapsedSeconds !== null && (
        <Text color={consolePalette.accent}> · {formatElapsed(elapsedSeconds)}</Text>
      )}
    </Box>
  )
}

export function terminalMotionEnabled(environment: NodeJS.ProcessEnv): boolean {
  const reduced = environment.GEO_AGENT_PLATFORM_REDUCED_MOTION?.trim().toLowerCase()
  if (reduced === '1' || reduced === 'true') return false
  if (environment.CI?.trim().toLowerCase() === 'true') return false
  return environment.TERM?.trim().toLowerCase() !== 'dumb'
}

function useActivityElapsedSeconds(
  activity: AgentActivityDescriptor,
  animationsEnabled: boolean,
): number | null {
  const [elapsed, setElapsed] = useState(() => activityElapsedSeconds(activity.startedAt))
  useEffect(() => {
    setElapsed(activityElapsedSeconds(activity.startedAt))
    if (!animationsEnabled || !activity.startedAt) return
    const timer = setInterval(() => setElapsed(activityElapsedSeconds(activity.startedAt)), 1_000)
    return () => clearInterval(timer)
  }, [activity.key, activity.startedAt, animationsEnabled])
  return animationsEnabled ? elapsed : null
}

function activityElapsedSeconds(startedAt: string | null): number | null {
  if (!startedAt) return null
  const started = Date.parse(startedAt)
  if (!Number.isFinite(started)) return null
  return Math.max(0, Math.floor((Date.now() - started) / 1_000))
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

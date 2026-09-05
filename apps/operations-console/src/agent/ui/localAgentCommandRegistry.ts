// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 斜杠命令注册表
//
//   文件:       localAgentCommandRegistry.ts
//
//   日期:       2026年07月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { LocalAgentSession, LocalAgentSessionSnapshot } from '../application/localAgentSession.js'

type LocalAgentSlashCommandId =
  | 'help'
  | 'new'
  | 'history'
  | 'plan'
  | 'auto'
  | 'reasoning'
  | 'resume'
  | 'cancel'
  | 'model'
  | 'tools'
  | 'agents'
  | 'status'
  | 'exit'

export interface LocalAgentSlashCommandDefinition {
  id: LocalAgentSlashCommandId
  command: `/${string}`
  usage: string
  description: string
  aliases?: readonly `/${string}`[]
  expectsArgument?: boolean
  execute: (context: LocalAgentSlashCommandContext, argument: string) => void
}

type LocalAgentSlashCommandSession = Pick<
  LocalAgentSession,
  'setExecutionMode' | 'setReasoning' | 'resume' | 'cancel'
>

interface LocalAgentSlashCommandContext {
  snapshot: LocalAgentSessionSnapshot
  session: LocalAgentSlashCommandSession
  setFeedback: (message: string) => void
  showHelp: () => void
  showHistory: () => void
  showStatus: () => void
  disconnect: () => void
  beginNewConversation: () => void
  runAction: (action: () => Promise<void>) => Promise<void>
}

export interface ParsedLocalAgentSlashCommand {
  rawCommand: string
  argument: string
  definition: LocalAgentSlashCommandDefinition | null
}

// 每个注册项同时拥有提示元数据、别名、参数行为和执行逻辑。新增命令只需
// 在此增加一项，输入建议、帮助页与执行分派会自动共享同一事实源。
export const localAgentSlashCommands: readonly LocalAgentSlashCommandDefinition[] = [
  {
    id: 'help',
    command: '/help',
    usage: '/help',
    description: '打开快捷键与命令帮助',
    aliases: ['/?'],
    execute: context => context.showHelp(),
  },
  {
    id: 'new',
    command: '/new',
    usage: '/new',
    description: '开始新的本地 Agent 对话',
    execute: context => context.beginNewConversation(),
  },
  {
    id: 'history',
    command: '/history',
    usage: '/history',
    description: '筛选并打开最近对话',
    execute: context => context.showHistory(),
  },
  {
    id: 'plan',
    command: '/plan',
    usage: '/plan',
    description: '下一次运行使用计划模式',
    execute: context => {
      context.session.setExecutionMode('plan')
      context.setFeedback('下一次运行将使用计划模式。')
    },
  },
  {
    id: 'auto',
    command: '/auto',
    usage: '/auto',
    description: '下一次运行使用自动模式',
    execute: context => {
      context.session.setExecutionMode('auto')
      context.setFeedback('下一次运行将使用自动模式。')
    },
  },
  {
    id: 'reasoning',
    command: '/reasoning',
    usage: '/reasoning on|off',
    description: '开启或关闭思考过程',
    expectsArgument: true,
    execute: (context, argument) => {
      const enabled = argument !== 'off'
      context.session.setReasoning(enabled)
      context.setFeedback(`思考过程已${enabled ? '开启' : '关闭'}。`)
    },
  },
  {
    id: 'resume',
    command: '/resume',
    usage: '/resume',
    description: '恢复当前等待中的运行',
    execute: context => {
      void context.runAction(async () => {
        await context.session.resume()
        context.setFeedback('运行恢复请求已提交。')
      })
    },
  },
  {
    id: 'cancel',
    command: '/cancel',
    usage: '/cancel',
    description: '取消当前运行',
    execute: context => {
      void context.runAction(async () => {
        await context.session.cancel()
        context.setFeedback('运行已取消。')
      })
    },
  },
  {
    id: 'model',
    command: '/model',
    usage: '/model',
    description: '查看当前模型',
    execute: context => context.setFeedback(
      `当前模型：${context.snapshot.provider?.displayName ?? '未连接'} / ${context.snapshot.model ?? '未配置'}；模型由服务端能力清单约束。`,
    ),
  },
  {
    id: 'tools',
    command: '/tools',
    usage: '/tools',
    description: '查看工作区工具摘要',
    execute: context => context.setFeedback(
      `当前工作区注册了 ${context.snapshot.bootstrap?.tools.length ?? 0} 个工具；详细调用会显示在对话时间线。`,
    ),
  },
  {
    id: 'agents',
    command: '/agents',
    usage: '/agents',
    description: '查看子智能体摘要',
    execute: context => {
      const agents = context.snapshot.run?.state.subAgents ?? []
      context.setFeedback(agents.length
        ? `子智能体：${agents.map(agent => `${agent.name}(${agent.status})`).join('、')}`
        : '当前没有子智能体。')
    },
  },
  {
    id: 'status',
    command: '/status',
    usage: '/status',
    description: '查看运行与连接状态',
    execute: context => context.showStatus(),
  },
  {
    id: 'exit',
    command: '/exit',
    usage: '/exit',
    description: '分离终端并保留后台服务',
    aliases: ['/quit'],
    execute: context => context.disconnect(),
  },
]

export function parseLocalAgentSlashCommand(value: string): ParsedLocalAgentSlashCommand | null {
  const [rawCommand = '', ...parts] = value.trim().split(/\s+/u)
  const normalized = rawCommand.toLowerCase()
  if (!normalized.startsWith('/')) return null
  const definition = localAgentSlashCommands.find(command => (
    command.command === normalized || command.aliases?.includes(normalized as `/${string}`)
  ))
    ?? (normalized === '/mode' && (parts[0] === 'plan' || parts[0] === 'auto')
      ? localAgentSlashCommands.find(command => command.id === parts[0])
      : undefined)
  return {
    rawCommand: normalized,
    argument: parts.join(' ').toLowerCase(),
    definition: definition ?? null,
  }
}

export function suggestLocalAgentSlashCommands(value: string): LocalAgentSlashCommandDefinition[] {
  if (!value.startsWith('/') || value.includes('\n') || /\s/u.test(value)) return []
  const query = value.toLowerCase()
  return localAgentSlashCommands
    .filter(command => (
      command.command.startsWith(query)
      || command.aliases?.some(alias => alias.startsWith(query))
    ))
}

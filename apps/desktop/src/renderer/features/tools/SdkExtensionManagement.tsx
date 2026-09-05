// +-------------------------------------------------------------------------
//
//   地理智能平台 - SDK 扩展管理面板
//
//   文件:       SdkExtensionManagement.tsx
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-31):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 增加 Responses API 原生工具配置，服务端能力与本地 MCP 分区管理。
// --------------------------------------------------------------------------

import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  FolderCog,
  Globe2,
  KeyRound,
  Network,
  Plus,
  Save,
  Search,
  Server,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import {
  agentRuntimeConfigSchema,
  type AgentRuntimeConfig,
  type RuntimeMcpServerConfig,
  type SkillCatalogEntry,
  type SkillCatalogSnapshot,
  type SkillMatchResult,
} from '@geo-agent-platform/shared-types'

import { StatusPill } from '../../shared/components/StatusPill'
import type { MemoryEntry } from '../memory/types'

export type SdkManagementView = 'mcp' | 'skills' | 'memory'

interface SdkExtensionManagementProps {
  view: SdkManagementView
  runtimeConfig?: AgentRuntimeConfig
  skillCatalog?: SkillCatalogSnapshot
  skillSearchResults?: SkillMatchResult[]
  memories?: MemoryEntry[]
  activeSkills?: string[]
  activeMcpServers?: string[]
  isSaving?: boolean
  isSkillSearching?: boolean
  onRefreshMemories?: () => void
  onSaveRuntimeConfig?: (config: AgentRuntimeConfig) => void | Promise<void>
  onSearchSkills?: (query: string) => Promise<SkillMatchResult[]>
}

interface RuntimeConfigDraftState {
  source?: AgentRuntimeConfig
  draft?: AgentRuntimeConfig
  dirty: boolean
  error?: string
  selectedMcpIndex: number
}

export function SdkExtensionManagement({
  view,
  runtimeConfig,
  skillCatalog,
  skillSearchResults = [],
  memories = [],
  activeSkills = [],
  activeMcpServers = [],
  isSaving,
  isSkillSearching,
  onRefreshMemories,
  onSaveRuntimeConfig,
  onSearchSkills,
}: SdkExtensionManagementProps) {
  const [skillQuery, setSkillQuery] = useState('')
  const [draftState, setDraftState] = useState<RuntimeConfigDraftState>({
    source: runtimeConfig,
    draft: runtimeConfig,
    dirty: false,
    error: undefined,
    selectedMcpIndex: 0,
  })
  const isDraftCurrent = draftState.source === runtimeConfig
  const draft = isDraftCurrent ? draftState.draft : runtimeConfig
  const dirty = isDraftCurrent ? draftState.dirty : false
  const error = isDraftCurrent ? draftState.error : undefined
  const selectedMcpIndex = Math.max(0, Math.min(
    isDraftCurrent ? draftState.selectedMcpIndex : 0,
    Math.max((draft?.sdk.mcp.servers.length ?? 1) - 1, 0),
  ))

  const selectedServer = draft?.sdk.mcp.servers[selectedMcpIndex]
  const mcpSummary = useMemo(() => {
    const servers = draft?.sdk.mcp.servers ?? []
    return {
      total: servers.length,
      enabled: servers.filter(server => server.enabled).length,
    }
  }, [draft?.sdk.mcp.servers])
  const skillMatchesById = useMemo(
    () => new Map(skillSearchResults.map(match => [match.skillId, match])),
    [skillSearchResults],
  )

  const applyDraft = (updater: (config: AgentRuntimeConfig) => AgentRuntimeConfig) => {
    setDraftState(current => {
      const base = current.source === runtimeConfig ? current.draft : runtimeConfig
      if (!base) return current
      return {
        source: runtimeConfig,
        draft: updater(base),
        dirty: true,
        error: undefined,
        selectedMcpIndex: current.source === runtimeConfig ? current.selectedMcpIndex : 0,
      }
    })
  }

  const updateSelectedMcpIndex = (nextIndex: number | ((current: number) => number)) => {
    setDraftState(current => {
      const baseIndex = current.source === runtimeConfig ? current.selectedMcpIndex : 0
      const resolvedIndex = typeof nextIndex === 'function' ? nextIndex(baseIndex) : nextIndex
      return {
        source: runtimeConfig,
        draft,
        dirty: current.source === runtimeConfig ? current.dirty : false,
        error: current.source === runtimeConfig ? current.error : undefined,
        selectedMcpIndex: Math.max(0, resolvedIndex),
      }
    })
  }

  const setDraftError = (message?: string) => {
    setDraftState(current => ({
      source: runtimeConfig,
      draft,
      dirty: current.source === runtimeConfig ? current.dirty : false,
      error: message,
      selectedMcpIndex: current.source === runtimeConfig ? current.selectedMcpIndex : selectedMcpIndex,
    }))
  }

  const updateMcpServer = (index: number, fields: Partial<RuntimeMcpServerConfig>) => {
    applyDraft(config => ({
      ...config,
      sdk: {
        ...config.sdk,
        mcp: {
          ...config.sdk.mcp,
          servers: config.sdk.mcp.servers.map((server, candidateIndex) =>
            candidateIndex === index ? { ...server, ...fields } : server,
          ),
        },
      },
    }))
  }

  const updateMcpServerRecord = (
    index: number,
    field: 'env' | 'headers',
    value: string,
  ) => {
    try {
      updateMcpServer(index, { [field]: parseKeyValueLines(value) })
    } catch (recordError) {
      setDraftState(current => ({
        source: runtimeConfig,
        draft,
        dirty: true,
        error: recordError instanceof Error ? recordError.message : '键值配置格式无效。',
        selectedMcpIndex: current.source === runtimeConfig ? current.selectedMcpIndex : selectedMcpIndex,
      }))
    }
  }

  const addMcpServer = () => {
    applyDraft(config => ({
      ...config,
      sdk: {
        ...config.sdk,
        mcp: {
          ...config.sdk.mcp,
          servers: [...config.sdk.mcp.servers, createMcpServerDraft(config.sdk.mcp.servers.length + 1)],
        },
      },
    }))
    updateSelectedMcpIndex(draft?.sdk.mcp.servers.length ?? 0)
  }

  const removeMcpServer = (index: number) => {
    applyDraft(config => ({
      ...config,
      sdk: {
        ...config.sdk,
        mcp: {
          ...config.sdk.mcp,
          servers: config.sdk.mcp.servers.filter((_, candidateIndex) => candidateIndex !== index),
        },
      },
    }))
    updateSelectedMcpIndex(previous => Math.max(0, Math.min(previous, (draft?.sdk.mcp.servers.length ?? 1) - 2)))
  }

  const updateSkillRegistration = (
    skill: SkillCatalogEntry,
    update: { enabled?: boolean; trustCurrentDigest?: boolean },
  ) => {
    applyDraft(config => ({
      ...config,
      sdk: {
        ...config.sdk,
        skills: {
          ...config.sdk.skills,
          registrations: upsertSkillRegistration(config, skill, update),
        },
      },
    }))
  }

  const save = async () => {
    if (!draft || !onSaveRuntimeConfig) return
    const parsed = agentRuntimeConfigSchema.safeParse(draft)
    if (!parsed.success) {
      setDraftError(parsed.error.issues[0]?.message ?? '运行时配置校验失败。')
      return
    }
    await onSaveRuntimeConfig(parsed.data)
    setDraftState(current => ({
      ...current,
      source: runtimeConfig,
      draft: parsed.data,
      dirty: false,
      error: undefined,
    }))
  }

  if (!draft) {
    return (
      <main className="tool-management__detail tool-management__detail--extensions">
        <section className="panel sdk-config-panel">
          <div className="panel__header">
            <div>
              <div className="panel__eyebrow">SDK Extensions</div>
              <h2>正在加载运行时配置</h2>
            </div>
          </div>
          <div className="panel__section">
            <div className="panel__empty">运行时配置尚未返回，稍后会显示 MCP、Skill 与记忆管理。</div>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="tool-management__detail tool-management__detail--extensions">
      <section className="panel sdk-config-panel sdk-config-panel--summary">
        <div className="panel__header">
          <div>
            <div className="panel__eyebrow">OpenAI Agents SDK</div>
            <h2>{viewTitle(view)}</h2>
          </div>
          <div className="sdk-config-panel__actions">
            <StatusPill label={dirty ? '有未应用修改' : '配置已同步'} tone={dirty ? 'warning' : 'success'} />
            <button
              type="button"
              className="toolbar-button toolbar-button--primary"
              disabled={!dirty || !onSaveRuntimeConfig || Boolean(isSaving)}
              onClick={() => {
                void save()
              }}
            >
              <Save size={15} aria-hidden="true" />
              <span>{isSaving ? '保存中' : '应用配置'}</span>
            </button>
          </div>
        </div>
        {error ? (
          <div className="panel__section sdk-config-alert" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="panel__section sdk-config-overview">
          <CapabilityStat icon={Globe2} label="联网搜索" value={draft.sdk.hostedTools.webSearch.enabled ? '开启' : '关闭'} hint={`上下文：${searchContextSizeLabel(draft.sdk.hostedTools.webSearch.searchContextSize)}`} />
          <CapabilityStat icon={Network} label="MCP Server" value={`${mcpSummary.enabled}/${mcpSummary.total}`} hint={draft.sdk.mcp.enabled ? '运行时启用' : '运行时关闭'} />
          <CapabilityStat icon={FolderCog} label="Skill 注册表" value={String(skillCatalog?.entries.length ?? 0)} hint={draft.sdk.skills.enabled ? '摘要与信任校验' : '未启用'} />
          <CapabilityStat icon={Brain} label="长期记忆" value={draft.context.memoryEnabled ? '开启' : '关闭'} hint={`${memories.length} 条索引`} />
          <CapabilityStat icon={CheckCircle2} label="本轮 Skill" value={String(activeSkills.length)} hint={summarizeNames(activeSkills, '当前运行未装配 Skill')} />
          <CapabilityStat icon={Server} label="本轮 MCP" value={String(activeMcpServers.length)} hint={summarizeNames(activeMcpServers, '当前运行未连接 MCP')} />
        </div>
      </section>

      {view === 'mcp' ? (
        <section className="sdk-config-grid">
          <section className="panel sdk-config-panel">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">Responses API</div>
                <h2>服务端联网搜索</h2>
              </div>
              <StatusPill
                label={draft.sdk.hostedTools.webSearch.enabled ? '已启用' : '已关闭'}
                tone={draft.sdk.hostedTools.webSearch.enabled ? 'success' : 'neutral'}
              />
            </div>
            <div className="panel__section sdk-form-grid">
              <ToggleField
                label="允许模型联网搜索"
                checked={draft.sdk.hostedTools.webSearch.enabled}
                onChange={enabled => applyDraft(config => ({
                  ...config,
                  sdk: {
                    ...config.sdk,
                    hostedTools: {
                      ...config.sdk.hostedTools,
                      webSearch: {
                        ...config.sdk.hostedTools.webSearch,
                        enabled,
                      },
                    },
                  },
                }))}
              />
              <SelectField
                label="搜索上下文"
                value={draft.sdk.hostedTools.webSearch.searchContextSize}
                options={[['low', '精简'], ['medium', '均衡'], ['high', '充分']]}
                onChange={searchContextSize => applyDraft(config => ({
                  ...config,
                  sdk: {
                    ...config.sdk,
                    hostedTools: {
                      ...config.sdk.hostedTools,
                      webSearch: {
                        ...config.sdk.hostedTools.webSearch,
                        searchContextSize: searchContextSize as 'low' | 'medium' | 'high',
                      },
                    },
                  },
                }))}
              />
            </div>
            <div className="panel__section">
              <p className="sdk-config-note">
                该工具由 Responses API 在模型服务端执行，不经过本机 MCP；关闭后模型只能使用平台已注册的数据与工具。
              </p>
            </div>
          </section>

          <section className="panel sdk-config-panel">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">Control Plane</div>
                <h2>MCP 连接策略</h2>
              </div>
              <StatusPill label={draft.sdk.mcp.enabled ? '已启用' : '已关闭'} tone={draft.sdk.mcp.enabled ? 'success' : 'neutral'} />
            </div>
            <div className="panel__section sdk-form-grid">
              <ToggleField
                label="启用 MCP"
                checked={draft.sdk.mcp.enabled}
                onChange={enabled => applyDraft(config => ({ ...config, sdk: { ...config.sdk, mcp: { ...config.sdk.mcp, enabled } } }))}
              />
              <NumberField
                label="连接超时 ms"
                value={draft.sdk.mcp.connectTimeoutMs}
                onChange={connectTimeoutMs => applyDraft(config => ({ ...config, sdk: { ...config.sdk, mcp: { ...config.sdk.mcp, connectTimeoutMs } } }))}
              />
              <NumberField
                label="关闭超时 ms"
                value={draft.sdk.mcp.closeTimeoutMs}
                onChange={closeTimeoutMs => applyDraft(config => ({ ...config, sdk: { ...config.sdk, mcp: { ...config.sdk.mcp, closeTimeoutMs } } }))}
              />
            </div>
            <div className="panel__section">
              <p className="sdk-config-note">
                当前版本不读取系统环境密钥，也不允许在 MCP 请求头或环境变量中内嵌授权信息。
              </p>
            </div>
          </section>

          <section className="panel sdk-config-panel">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">服务注册表</div>
                <h2>MCP 服务</h2>
              </div>
              <button type="button" className="toolbar-button toolbar-button--primary" onClick={addMcpServer}>
                <Plus size={15} aria-hidden="true" />
                <span>新增 Server</span>
              </button>
            </div>
            <div className="panel__section sdk-mcp-layout">
              <div className="sdk-mcp-list">
                {draft.sdk.mcp.servers.length ? draft.sdk.mcp.servers.map((server, index) => (
                  <button
                    key={`${server.name}:${index}`}
                    type="button"
                    className={index === selectedMcpIndex ? 'sdk-mcp-card sdk-mcp-card--active' : 'sdk-mcp-card'}
                    onClick={() => updateSelectedMcpIndex(index)}
                  >
                    <span className="sdk-mcp-card__icon"><Server size={15} aria-hidden="true" /></span>
                    <span className="sdk-mcp-card__body">
                      <strong>{server.name || `server-${index + 1}`}</strong>
                      <small>{server.transport} · 本地 Function Tools</small>
                    </span>
                    <span className={server.enabled ? 'tool-card__status tool-card__status--ready' : 'tool-card__status'} />
                  </button>
                )) : (
                  <div className="panel__empty">还没有 MCP Server。</div>
                )}
              </div>

              {selectedServer ? (
                <div className="sdk-mcp-editor">
                  <div className="sdk-mcp-editor__head">
                    <strong>{selectedServer.name}</strong>
                    <button type="button" className="toolbar-button toolbar-button--danger" onClick={() => removeMcpServer(selectedMcpIndex)}>
                      <Trash2 size={14} aria-hidden="true" />
                      <span>删除</span>
                    </button>
                  </div>
                  <div className="sdk-form-grid sdk-form-grid--two">
                    <TextField label="名称" value={selectedServer.name} onChange={name => updateMcpServer(selectedMcpIndex, { name })} />
                    <ToggleField label="启用" checked={selectedServer.enabled} onChange={enabled => updateMcpServer(selectedMcpIndex, { enabled })} />
                    <SelectField
                      label="传输方式"
                      value={selectedServer.transport}
                      options={[['streamable_http', 'Streamable HTTP'], ['sse', 'SSE'], ['stdio', 'stdio']]}
                      onChange={transport => updateMcpServer(selectedMcpIndex, { transport: transport as RuntimeMcpServerConfig['transport'] })}
                    />
                    <SelectField
                      label="执行模式"
                      value={selectedServer.executionMode}
                      options={[['function_tools', '本地 Function Tools']]}
                      onChange={() => undefined}
                      disabled
                    />
                    <SelectField
                      label="审批策略"
                      value={selectedServer.approval}
                      options={[['always', '总是审批'], ['never', '无需审批']]}
                      onChange={approval => updateMcpServer(selectedMcpIndex, { approval: approval as RuntimeMcpServerConfig['approval'] })}
                    />
                    <NumberField label="工具超时 ms" value={selectedServer.timeoutMs} onChange={timeoutMs => updateMcpServer(selectedMcpIndex, { timeoutMs })} />
                    <TextField label="URL" value={selectedServer.url ?? ''} onChange={url => updateMcpServer(selectedMcpIndex, { url: emptyToNull(url) })} />
                    <TextField label="stdio command" value={selectedServer.command ?? ''} onChange={command => updateMcpServer(selectedMcpIndex, { command: emptyToNull(command) })} />
                    <TextField label="stdio args" value={joinCsv(selectedServer.args)} onChange={args => updateMcpServer(selectedMcpIndex, { args: splitCsv(args) })} />
                    <TextField label="工作目录" value={selectedServer.cwd ?? ''} onChange={cwd => updateMcpServer(selectedMcpIndex, { cwd: emptyToNull(cwd) })} />
                    <TextField label="允许工具" value={joinCsv(selectedServer.allowedTools)} onChange={allowedTools => updateMcpServer(selectedMcpIndex, { allowedTools: splitCsv(allowedTools) })} />
                    <TextField label="屏蔽工具" value={joinCsv(selectedServer.blockedTools)} onChange={blockedTools => updateMcpServer(selectedMcpIndex, { blockedTools: splitCsv(blockedTools) })} />
                    <TextAreaField
                      label="HTTP Headers"
                      value={formatKeyValueLines(selectedServer.headers)}
                      placeholder="例如：x-api-version: 2026-07-08"
                      onChange={value => updateMcpServerRecord(selectedMcpIndex, 'headers', value)}
                    />
                    <TextAreaField
                      label="stdio 环境变量"
                      value={formatKeyValueLines(selectedServer.env)}
                      placeholder="例如：NODE_ENV=production"
                      onChange={value => updateMcpServerRecord(selectedMcpIndex, 'env', value)}
                    />
                    <ToggleField label="工具名包含服务器名" checked={selectedServer.includeServerInToolNames} onChange={includeServerInToolNames => updateMcpServer(selectedMcpIndex, { includeServerInToolNames })} />
                    <ToggleField label="严格化工具结构" checked={selectedServer.convertSchemasToStrict} onChange={convertSchemasToStrict => updateMcpServer(selectedMcpIndex, { convertSchemasToStrict })} />
                    <ToggleField label="缓存工具列表" checked={selectedServer.cacheToolsList} onChange={cacheToolsList => updateMcpServer(selectedMcpIndex, { cacheToolsList })} />
                    <ToggleField label="使用结构化内容" checked={selectedServer.useStructuredContent} onChange={useStructuredContent => updateMcpServer(selectedMcpIndex, { useStructuredContent })} />
                    <TextAreaField label="说明" value={selectedServer.description} onChange={description => updateMcpServer(selectedMcpIndex, { description })} />
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </section>
      ) : null}

      {view === 'skills' ? (
        <section className="sdk-config-grid sdk-config-grid--skills">
          <section className="panel sdk-config-panel">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">SDK Skills</div>
                <h2>Skill 来源与路由</h2>
              </div>
              <StatusPill label={draft.sdk.skills.enabled ? '已启用' : '已关闭'} tone={draft.sdk.skills.enabled ? 'success' : 'neutral'} />
            </div>
            <div className="panel__section sdk-form-grid">
              <ToggleField
                label="启用 Skill 路由"
                checked={draft.sdk.skills.enabled}
                onChange={enabled => applyDraft(config => ({ ...config, sdk: { ...config.sdk, skills: { ...config.sdk.skills, enabled } } }))}
              />
              <TextField
                label="sandbox 内路径"
                value={draft.sdk.skills.skillsPath}
                onChange={skillsPath => applyDraft(config => ({ ...config, sdk: { ...config.sdk, skills: { ...config.sdk.skills, skillsPath } } }))}
              />
              <TextAreaField
                label="单个 Skill 目录"
                value={draft.sdk.skills.skillPaths.join('\n')}
                placeholder="每行一个 Skill 目录，目录内必须有 SKILL.md"
                onChange={value => applyDraft(config => ({ ...config, sdk: { ...config.sdk, skills: { ...config.sdk.skills, skillPaths: splitLines(value) } } }))}
              />
              <TextAreaField
                label="Skill 根目录"
                value={draft.sdk.skills.skillRoots.join('\n')}
                placeholder="每行一个根目录，子目录会作为 Skill 扫描"
                onChange={value => applyDraft(config => ({ ...config, sdk: { ...config.sdk, skills: { ...config.sdk.skills, skillRoots: splitLines(value) } } }))}
              />
            </div>
            <div className="panel__section sdk-rule-list">
              <RuleItem icon={CheckCircle2} title="入口与摘要都受校验" body="入口必须严格为 SKILL.md；脚本、参考和资源的任何变化都会改变 SHA-256 摘要。" />
              <RuleItem icon={FolderCog} title="确定性路由" body="按 /skill-id、精确名称/别名和词项相关度匹配；低置信候选只展示，不注入运行时。" />
              <RuleItem icon={KeyRound} title="不是权限绕过入口" body="Skill 只提供说明与资源，仍受工具 RBAC、审批、文件沙箱和运行模式约束。" />
            </div>
          </section>

          <section className="panel sdk-config-panel">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">Trusted Registry</div>
                <h2>GIS Skill 注册表</h2>
              </div>
              <StatusPill
                label={`${skillCatalog?.entries.filter(skill => skill.active).length ?? 0}/${skillCatalog?.entries.length ?? 0} 可用`}
                tone={skillCatalog?.entries.some(skill => skill.active) ? 'success' : 'neutral'}
              />
            </div>
            <div className="panel__section">
              <form
                className="sdk-skill-search"
                onSubmit={event => {
                  event.preventDefault()
                  if (onSearchSkills) void onSearchSkills(skillQuery)
                }}
              >
                <Search size={15} aria-hidden="true" />
                <input
                  className="composer__input"
                  value={skillQuery}
                  placeholder="输入任务，查看匹配分数与原因"
                  aria-label="搜索 Skill"
                  onChange={event => setSkillQuery(event.target.value)}
                />
                <button className="toolbar-button" type="submit" disabled={!skillQuery.trim() || !onSearchSkills || Boolean(isSkillSearching)}>
                  {isSkillSearching ? '匹配中' : '测试路由'}
                </button>
              </form>
              {skillSearchResults.length ? (
                <div className="sdk-skill-match-list" aria-label="Skill 匹配解释">
                  {skillSearchResults.map(match => (
                    <div key={match.skillId}>
                      <strong>{match.name} · {Math.round(match.score * 100)}%</strong>
                      <span>{match.reason}{match.autoLoad ? '（将自动装配）' : '（仅候选）'}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            {skillCatalog?.diagnostics.length ? (
              <div className="panel__section sdk-skill-diagnostics" role="status">
                {skillCatalog.diagnostics.map((diagnostic, index) => (
                  <div key={`${diagnostic.code}:${diagnostic.skillId ?? diagnostic.sourceLabel ?? index}`}>
                    <AlertTriangle size={14} aria-hidden="true" />
                    <span>{diagnostic.message}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="panel__section sdk-skill-list">
              {skillCatalog?.entries.length ? skillCatalog.entries.map(skill => {
                const registration = draft.sdk.skills.registrations.find(item => item.skillId === skill.skillId)
                const draftEnabled = registration?.enabled ?? skill.enabled
                const draftTrusted = skill.source.kind === 'builtin'
                  || registration?.trustedDigest === skill.contentDigest
                const match = skillMatchesById.get(skill.skillId)
                return (
                  <article key={skill.skillId} className="sdk-skill-card">
                    <div className="sdk-skill-card__head">
                      <div>
                        <strong>{skill.name}</strong>
                        <small>{skill.skillId} · v{skill.version}</small>
                      </div>
                      <StatusPill label={skillTrustLabel(skill, draftEnabled, draftTrusted)} tone={skillTrustTone(skill, draftEnabled, draftTrusted)} />
                    </div>
                    <p>{skill.description}</p>
                    <div className="sdk-skill-card__meta">
                      <span>{skill.source.label}</span>
                      <code>{skill.contentDigest.slice(0, 19)}…</code>
                    </div>
                    <div className="sdk-skill-card__tags">
                      {skill.tags.map(tag => <span key={tag}>{tag}</span>)}
                    </div>
                    {match ? <div className="sdk-skill-card__match">{match.reason}</div> : null}
                    <div className="sdk-skill-card__actions">
                      <button type="button" className="toolbar-button" onClick={() => updateSkillRegistration(skill, { enabled: !draftEnabled })}>
                        {draftEnabled ? '禁用' : '启用'}
                      </button>
                      {skill.source.kind !== 'builtin' && !draftTrusted ? (
                        <button type="button" className="toolbar-button toolbar-button--primary" onClick={() => updateSkillRegistration(skill, { enabled: true, trustCurrentDigest: true })}>
                          {skill.trustStatus === 'content_changed' ? '重新信任此摘要' : '信任此摘要'}
                        </button>
                      ) : null}
                    </div>
                  </article>
                )
              }) : (
                <div className="panel__empty">正在读取 Skill 注册表。</div>
              )}
            </div>
          </section>
        </section>
      ) : null}

      {view === 'memory' ? (
        <section className="sdk-config-grid sdk-config-grid--memory">
          <section className="panel sdk-config-panel">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">Memory Runtime</div>
                <h2>记忆系统</h2>
              </div>
              <button type="button" className="toolbar-button" onClick={onRefreshMemories}>
                <Clock size={15} aria-hidden="true" />
                <span>刷新索引</span>
              </button>
            </div>
            <div className="panel__section sdk-form-grid">
              <ToggleField label="启用长期记忆" checked={draft.context.memoryEnabled} onChange={memoryEnabled => applyDraft(config => ({ ...config, context: { ...config.context, memoryEnabled } }))} />
              <ToggleField label="启用团队记忆" checked={draft.context.teamMemoryEnabled} onChange={teamMemoryEnabled => applyDraft(config => ({ ...config, context: { ...config.context, teamMemoryEnabled } }))} />
              <ToggleField label="启用会话记忆" checked={draft.context.sessionMemoryEnabled} onChange={sessionMemoryEnabled => applyDraft(config => ({ ...config, context: { ...config.context, sessionMemoryEnabled } }))} />
              <ToggleField label="自动提取" checked={draft.context.memoryAutoExtractEnabled} onChange={memoryAutoExtractEnabled => applyDraft(config => ({ ...config, context: { ...config.context, memoryAutoExtractEnabled } }))} />
              <ToggleField label="自动整理" checked={draft.context.memoryAutoDreamEnabled} onChange={memoryAutoDreamEnabled => applyDraft(config => ({ ...config, context: { ...config.context, memoryAutoDreamEnabled } }))} />
              <TextField label="记忆基目录" value={draft.context.memoryBaseDir} onChange={memoryBaseDir => applyDraft(config => ({ ...config, context: { ...config.context, memoryBaseDir } }))} />
              <TextField label="私有目录覆盖" value={draft.context.privateMemoryDir ?? ''} onChange={privateMemoryDir => applyDraft(config => ({ ...config, context: { ...config.context, privateMemoryDir: emptyToNull(privateMemoryDir) } }))} />
              <TextField label="团队目录覆盖" value={draft.context.teamMemoryDir ?? ''} onChange={teamMemoryDir => applyDraft(config => ({ ...config, context: { ...config.context, teamMemoryDir: emptyToNull(teamMemoryDir) } }))} />
              <NumberField label="索引最大行数" value={draft.context.memoryMaxIndexLines} onChange={memoryMaxIndexLines => applyDraft(config => ({ ...config, context: { ...config.context, memoryMaxIndexLines } }))} />
              <NumberField label="相关记忆上限" value={draft.context.memoryRelevantLimit} onChange={memoryRelevantLimit => applyDraft(config => ({ ...config, context: { ...config.context, memoryRelevantLimit } }))} />
            </div>
          </section>
          <section className="panel sdk-config-panel">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">Memory Index</div>
                <h2>当前记忆</h2>
              </div>
              <StatusPill label={`${memories.length} 条`} tone={memories.length ? 'accent' : 'neutral'} />
            </div>
            <div className="panel__section sdk-memory-list">
              {memories.length ? memories.map(memory => (
                <article key={`${memory.type}:${memory.name}`} className="sdk-memory-card">
                  <span className={`sdk-memory-card__type sdk-memory-card__type--${memory.type}`}>
                    {memoryTypeLabel(memory.type)}
                  </span>
                  <div>
                    <strong>{memory.name}</strong>
                    <p>{memory.description}</p>
                  </div>
                  <small>{memory.age}</small>
                </article>
              )) : (
                <div className="panel__empty">暂无可展示的记忆索引。</div>
              )}
            </div>
          </section>
        </section>
      ) : null}
    </main>
  )
}

function upsertSkillRegistration(
  config: AgentRuntimeConfig,
  skill: SkillCatalogEntry,
  update: { enabled?: boolean; trustCurrentDigest?: boolean },
): AgentRuntimeConfig['sdk']['skills']['registrations'] {
  const existing = config.sdk.skills.registrations.find(item => item.skillId === skill.skillId)
  const next = {
    skillId: skill.skillId,
    enabled: update.enabled ?? existing?.enabled ?? skill.enabled,
    trustedDigest: update.trustCurrentDigest
      ? skill.contentDigest
      : existing?.trustedDigest ?? null,
  }
  return [
    ...config.sdk.skills.registrations.filter(item => item.skillId !== skill.skillId),
    next,
  ].sort((left, right) => left.skillId.localeCompare(right.skillId))
}

function skillTrustLabel(skill: SkillCatalogEntry, enabled: boolean, digestTrusted: boolean): string {
  if (!enabled) return '已禁用'
  if (skill.source.kind === 'builtin') return '内置可信'
  if (digestTrusted) return skill.trustStatus === 'trusted' ? '已信任' : '待应用信任'
  if (skill.trustStatus === 'content_changed') return '摘要已变化'
  return '未信任'
}

function skillTrustTone(skill: SkillCatalogEntry, enabled: boolean, digestTrusted: boolean): string {
  if (!enabled) return 'neutral'
  if (skill.source.kind === 'builtin' || skill.trustStatus === 'trusted') return 'success'
  if (digestTrusted) return 'accent'
  return 'warning'
}

function memoryTypeLabel(type: MemoryEntry['type']): string {
  return {
    user: '用户',
    feedback: '反馈',
    project: '项目',
    reference: '参考',
  }[type]
}

function CapabilityStat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: LucideIcon
  label: string
  value: string
  hint: string
}) {
  return (
    <article className="sdk-capability-stat">
      <span><Icon size={16} aria-hidden="true" /></span>
      <div>
        <strong>{value}</strong>
        <p>{label} · {hint}</p>
      </div>
    </article>
  )
}

function RuleItem({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon
  title: string
  body: string
}) {
  return (
    <article className="sdk-rule-item">
      <span><Icon size={16} aria-hidden="true" /></span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </article>
  )
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  return (
    <label className="composer__label sdk-field">
      <span>{label}</span>
      <input className="composer__input" value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
    </label>
  )
}

function TextAreaField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  return (
    <label className="composer__label sdk-field sdk-field--wide">
      <span>{label}</span>
      <textarea className="composer__textarea" rows={4} value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
    </label>
  )
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="composer__label sdk-field">
      <span>{label}</span>
      <input
        className="composer__input"
        type="number"
        min={1}
        value={value}
        onChange={event => onChange(Number(event.target.value) || 1)}
      />
    </label>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string
  value: string
  options: Array<[string, string]>
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <label className="composer__label sdk-field">
      <span>{label}</span>
      <select className="composer__select" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </label>
  )
}

function searchContextSizeLabel(value: 'low' | 'medium' | 'high'): string {
  if (value === 'low') return '精简'
  if (value === 'high') return '充分'
  return '均衡'
}

function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="sdk-toggle">
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
      <span aria-hidden="true" />
      <strong>{label}</strong>
    </label>
  )
}

function viewTitle(view: SdkManagementView) {
  if (view === 'mcp') return 'MCP 管理'
  if (view === 'skills') return 'Skill 管理'
  return '记忆管理'
}

function createMcpServerDraft(index: number): RuntimeMcpServerConfig {
  return {
    enabled: true,
    name: `mcp-${index}`,
    description: '',
    transport: 'streamable_http',
    executionMode: 'function_tools',
    url: null,
    command: null,
    args: [],
    cwd: null,
    env: {},
    headers: {},
    allowedTools: [],
    blockedTools: [],
    includeServerInToolNames: true,
    convertSchemasToStrict: true,
    cacheToolsList: true,
    useStructuredContent: true,
    approval: 'always',
    timeoutMs: 20_000,
  }
}

function splitCsv(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function joinCsv(value: string[]): string {
  return value.join(', ')
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean)
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function formatKeyValueLines(record: Record<string, string>): string {
  return Object.entries(record).map(([key, value]) => `${key}: ${value}`).join('\n')
}

function parseKeyValueLines(value: string): Record<string, string> {
  const output: Record<string, string> = {}
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const equalsIndex = trimmed.indexOf('=')
    const colonIndex = trimmed.indexOf(':')
    const separator = equalsIndex >= 0 && (colonIndex < 0 || equalsIndex < colonIndex)
      ? equalsIndex
      : colonIndex
    if (separator < 1) throw new Error(`键值行格式无效：${trimmed}`)
    const key = trimmed.slice(0, separator).trim()
    const nextValue = trimmed.slice(separator + 1).trim()
    if (!key) throw new Error(`键值行缺少键名：${trimmed}`)
    output[key] = nextValue
  }
  return output
}

function summarizeNames(values: string[], emptyLabel: string): string {
  if (!values.length) return emptyLabel
  const visible = values.slice(0, 3).join('、')
  return values.length > 3 ? `${visible} 等 ${values.length} 项` : visible
}

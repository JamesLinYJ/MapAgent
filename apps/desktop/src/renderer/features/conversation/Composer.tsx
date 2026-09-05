// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话输入框
//
//   文件:       Composer.tsx
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { useEffect,useMemo,useState,type ClipboardEvent as ReactClipboardEvent,type CSSProperties,type FormEvent,type KeyboardEvent as ReactKeyboardEvent,type RefObject } from 'react'
import { Check,ChevronDown,ClipboardList,FolderUp,Hand,LoaderCircle,Mic,MicOff,ShieldOff,Sparkles,Square,Target,Upload,X,Zap } from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import type { RunAttachmentInput,SpeechLanguageOption } from '@geo-agent-platform/shared-types'
import type { DesktopFileSelectionHandle } from '../../../contracts/desktopIpc'
import { AppIcon } from '../../shared/components/AppIcon'
import { releaseDesktopFileHandle,selectDesktopUploadFiles,stageDesktopImageBlob } from '../../api/desktopFiles'
import type { UploadReference } from '../../app/types'
import { COMPOSER_MODES,composerModeOption,isSelectableComposerMode } from './composerModes'
import type { ChatPanelProps,ComposerMode,GoalComposerDraft } from './types'
import type { SpeechRecognitionStatus } from './useSpeechRecognition'

interface ComposerProps {
  query: string
  providerLabel: string
  submissionDisabledReason?: string
  isSubmitting: boolean
  conversationReady: boolean
  canSteerActiveRun: boolean
  composerMode: ComposerMode
  tokenBudget?: ChatPanelProps['tokenBudget']
  activeSkills?: string[]
  activeMcpServers?: string[]
  compactionLevel?: string | null
  runStats?: ChatPanelProps['runStats']
  threadUsage?: ChatPanelProps['threadUsage']
  threadUsageLoading?: boolean
  threadUsageUnavailable?: boolean
  denialCounts?: Record<string, number>
  goal?: ChatPanelProps['goal']
  goalDraft: GoalComposerDraft
  goalError?: string | null
  onGoalDraftChange: (updates: Partial<GoalComposerDraft>) => void
  composerInputRef: RefObject<HTMLTextAreaElement | null>
  onQueryChange: (value: string) => void
  onSubmit: (event?: FormEvent) => void
  onInterrupt?: () => void
  onUseTemplate: () => void
  onUploadFiles: (files: DesktopFileSelectionHandle[]) => void
  pendingAttachments?: RunAttachmentInput[]
  onAttachPastedImage?: (file: DesktopFileSelectionHandle) => Promise<void>
  onRemoveAttachment?: (fileId: string) => void
  uploadReferences?: UploadReference[]
  onDismissUploadReference?: (id: string) => void
  speechStatus?: SpeechRecognitionStatus
  speechError?: string | null
  speechInterimText?: string
  speechLanguage?: string
  speechLanguages?: SpeechLanguageOption[]
  onSpeechLanguageChange?: (language: string) => void
  onStartSpeechRecognition?: () => void
  onStopSpeechRecognition?: () => void
  onClearSpeechError?: () => void
  modeMenuOpen: boolean
  onModeMenuOpenChange: (open: boolean) => void
  onComposerModeChange: (mode: ComposerMode) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
  onInputKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void
}

// Composer 只维护用户正在编辑的输入态和按钮交互。
//
// 提交后是否清空由 AppShell 在 run:start 被接受前处理，避免输入框自行伪造提交成功。
export function Composer({
  query,
  providerLabel,
  submissionDisabledReason,
  isSubmitting,
  conversationReady,
  canSteerActiveRun,
  composerMode,
  tokenBudget,
  activeSkills,
  activeMcpServers,
  compactionLevel,
  runStats,
  threadUsage,
  threadUsageLoading,
  threadUsageUnavailable,
  denialCounts,
  goal,
  goalDraft,
  goalError,
  onGoalDraftChange,
  composerInputRef,
  onQueryChange,
  onSubmit,
  onInterrupt,
  onUseTemplate,
  onUploadFiles,
  pendingAttachments = [],
  onAttachPastedImage,
  onRemoveAttachment,
  uploadReferences = [],
  onDismissUploadReference,
  speechStatus = 'idle',
  speechError = null,
  speechInterimText = '',
  speechLanguage = 'zh-CN',
  speechLanguages = [],
  onSpeechLanguageChange,
  onStartSpeechRecognition,
  onStopSpeechRecognition,
  onClearSpeechError,
  modeMenuOpen,
  onModeMenuOpenChange,
  onComposerModeChange,
  onCompositionStart,
  onCompositionEnd,
  onInputKeyDown,
}: ComposerProps) {
  const mode = composerModeOption(composerMode)
  const modeShortLabel = mode.shortLabel
  const [pasteBusy, setPasteBusy] = useState(false)
  const [pasteError, setPasteError] = useState<string | null>(null)
  const canSubmit = conversationReady
    && !submissionDisabledReason
    && !pasteBusy
    && Boolean(query.trim())
    && (!isSubmitting || canSteerActiveRun)
  const speechEnabled = Boolean(onStartSpeechRecognition && onStopSpeechRecognition)
  const speechBusy = speechStatus === 'authorizing' || speechStatus === 'stopping'
  const speechActive = speechStatus === 'recognizing' || speechBusy
  const [goalPanelOpen, setGoalPanelOpen] = useState(false)
  const uploadCards = useMemo(() => visibleUploadCards(uploadReferences), [uploadReferences])

  useEffect(() => {
    const input = composerInputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 168)}px`
  }, [composerInputRef, query])

  const handlePaste = async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (!onAttachPastedImage) return
    const images = Array.from(event.clipboardData.items)
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (!images.length) return
    event.preventDefault()
    setPasteBusy(true)
    setPasteError(null)
    try {
      for (const [index, image] of images.slice(0, 12).entries()) {
        const extension = image.type === 'image/jpeg' ? 'jpg' : image.type.split('/')[1] || 'png'
        const handle = await stageDesktopImageBlob(
          image,
          image.name || `clipboard-${Date.now()}-${index + 1}.${extension}`,
        )
        try {
          await onAttachPastedImage(handle)
        } finally {
          await releaseDesktopFileHandle(handle.handleId).catch(() => undefined)
        }
      }
    } catch (error) {
      setPasteError(error instanceof Error ? error.message : '粘贴图片失败，请重试。')
    } finally {
      setPasteBusy(false)
    }
  }

  return (
    <form className="cc-composer" onSubmit={onSubmit}>
      <UploadProgressTray
        references={uploadCards}
        onDismiss={onDismissUploadReference}
      />
      <AttachmentTray
        attachments={pendingAttachments}
        busy={pasteBusy}
        onRemove={onRemoveAttachment}
      />
      <textarea
        id="analysis-query-input"
        ref={composerInputRef}
        className="cc-composer-input"
        value={query}
        aria-label="输入空间分析需求"
        aria-busy={!conversationReady || pasteBusy}
        placeholder={conversationReady ? '输入消息...' : '正在初始化会话...'}
        rows={1}
        wrap="soft"
        onChange={(event) => onQueryChange(event.target.value)}
        onPaste={(event) => { void handlePaste(event) }}
        onKeyDown={onInputKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        disabled={!conversationReady || (isSubmitting && !canSteerActiveRun)}
      />
      {pasteError ? <p className="cc-attachment-error" role="alert">{pasteError}</p> : null}

      <div className={`cc-composer-mode-note cc-composer-mode-note--${composerMode}`}>
        <span><Zap size={14} /> {mode.label}</span>
        <small>{mode.badge}</small>
      </div>

      {goalPanelOpen ? (
        <GoalEditor
          draft={goalDraft}
          currentGoal={goal}
          error={goalError}
          disabled={isSubmitting}
          onChange={onGoalDraftChange}
          onClose={() => setGoalPanelOpen(false)}
        />
      ) : null}

      <div className="cc-composer-toolbar">
        <div className="cc-composer-toolbar__primary" aria-label="输入附件与辅助工具">
          <FileUploadButton onUploadFiles={onUploadFiles} disabled={isSubmitting} />
          {speechEnabled ? (
            <SpeechInputControl
              status={speechStatus}
              error={speechError}
              language={speechLanguage}
              languages={speechLanguages}
              disabled={isSubmitting}
              onLanguageChange={onSpeechLanguageChange}
              onStart={onStartSpeechRecognition}
              onStop={onStopSpeechRecognition}
            />
          ) : null}
          <button
            className="cc-composer-tool cc-composer-tool--template"
            type="button"
            onClick={onUseTemplate}
            disabled={isSubmitting}
            title="填入示例问题"
            aria-label="填入示例问题"
          >
            <Sparkles size={16} />
          </button>
          <button
            className={`cc-composer-tool cc-composer-tool--goal${goalDraft.enabled ? ' cc-composer-tool--goal-active' : ''}`}
            type="button"
            onClick={() => setGoalPanelOpen(open => !open)}
            disabled={isSubmitting}
            title={goalDraft.enabled ? '编辑 Goal 验收边界' : '配置 Goal 验收与续跑边界'}
            aria-label={goalDraft.enabled ? '编辑 Goal 验收边界' : '配置 Goal 验收与续跑边界'}
            aria-expanded={goalPanelOpen}
          >
            <Target size={16} />
          </button>
          {onInterrupt && isSubmitting ? (
            <button className="cc-composer-tool cc-composer-tool--interrupt" type="button" onClick={onInterrupt} title="中断运行" aria-label="中断运行">
              <Square size={16} />
            </button>
          ) : null}
        </div>

        <div className="cc-composer-toolbar__secondary" aria-label="执行方式与发送">
          <span className="cc-composer-provider" title={submissionDisabledReason ?? providerLabel}>
            {providerLabel}
          </span>

          <div className="cc-mode-picker">
            <Popover.Root open={modeMenuOpen} onOpenChange={onModeMenuOpenChange}>
              <Popover.Trigger asChild>
                <button
                  className={`cc-mode-trigger cc-mode-trigger--${composerMode}`}
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={modeMenuOpen}
                  aria-label={`切换执行方式，当前为${mode.label}`}
                >
                  <ComposerModeIcon mode={mode.id} className="cc-mode-trigger__icon" size={14} />
                  <span className="cc-mode-trigger__label">{modeShortLabel}</span>
                  <ChevronDown size={13} />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  className="ui-popover-surface cc-mode-menu"
                  data-ui-surface="glass"
                  role="menu"
                  aria-label="切换执行方式"
                  side="top"
                  align="end"
                  sideOffset={12}
                  collisionPadding={10}
                  onOpenAutoFocus={(event) => event.preventDefault()}
                >
                  <div className="cc-mode-menu__head">
                    <span>执行方式</span>
                    <span className="cc-mode-menu__shortcut" aria-hidden="true">
                      <kbd>Shift</kbd>
                      <span>+</span>
                      <kbd>Tab</kbd>
                      <span>切换</span>
                    </span>
                  </div>
                  <div className="cc-mode-list">
                    {COMPOSER_MODES.map((item) => {
                      const selected = item.id === composerMode
                      const disabled = 'disabled' in item && item.disabled
                      const disabledReason = 'disabledReason' in item ? item.disabledReason : undefined
                      return (
                        <button
                          key={item.id}
                          className={`cc-mode-option${selected ? ' cc-mode-option--selected' : ''}${disabled ? ' cc-mode-option--disabled' : ''}`}
                          type="button"
                          data-mode={item.id}
                          role="menuitemradio"
                          aria-checked={selected}
                          aria-disabled={disabled || undefined}
                          disabled={disabled}
                          title={disabledReason}
                          onClick={() => {
                            if (!isSelectableComposerMode(item.id)) return
                            onComposerModeChange(item.id)
                            onModeMenuOpenChange(false)
                          }}
                        >
                          <span className="cc-mode-option__icon"><ComposerModeIcon mode={item.id} size={18} /></span>
                          <span className="cc-mode-option__copy">
                            <strong>{item.label}</strong>
                            <small>{item.description}</small>
                            {disabledReason ? <em>{disabledReason}</em> : null}
                          </span>
                          <span className="cc-mode-option__check" aria-hidden="true">
                            {selected ? <Check size={18} /> : null}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>

          <button
            className="cc-composer-tool cc-composer-tool--send"
            type="submit"
            disabled={!canSubmit}
            title={!conversationReady ? '正在初始化会话' : submissionDisabledReason ?? (canSteerActiveRun ? '发送引导消息' : isSubmitting ? '运行中' : '发送')}
            aria-label={!conversationReady ? '正在初始化会话' : submissionDisabledReason ?? (canSteerActiveRun ? '发送引导消息' : isSubmitting ? '运行中' : '发送')}
          >
            <AppIcon name="send" size={17} />
          </button>
        </div>
      </div>

      {speechEnabled && (speechActive || speechInterimText || speechError) ? (
        <div className={`cc-speech-status cc-speech-status--${speechError ? 'error' : speechStatus}`} role={speechError ? 'alert' : 'status'}>
          <span>{formatSpeechStatus(speechStatus, speechInterimText, speechError)}</span>
          {speechError && onClearSpeechError ? (
            <button type="button" onClick={onClearSpeechError} aria-label="关闭语音错误提示">
              <X size={13} />
            </button>
          ) : null}
        </div>
      ) : null}

      <ComposerDiagnostics
        tokenBudget={tokenBudget}
        activeSkills={activeSkills}
        activeMcpServers={activeMcpServers}
        compactionLevel={compactionLevel}
        runStats={runStats}
        denialCounts={denialCounts}
        goal={goal}
      />
      <ThreadUsageBar
        usage={threadUsage}
        loading={threadUsageLoading}
        unavailable={threadUsageUnavailable}
        active={isSubmitting}
      />
    </form>
  )
}

function GoalEditor({
  draft,
  currentGoal,
  error,
  disabled,
  onChange,
  onClose,
}: {
  draft: GoalComposerDraft
  currentGoal?: ChatPanelProps['goal']
  error?: string | null
  disabled: boolean
  onChange: (updates: Partial<GoalComposerDraft>) => void
  onClose: () => void
}) {
  return (
    <section className="cc-goal-editor" aria-label="Goal 验收配置">
      <div className="cc-goal-editor__head">
        <label className="cc-goal-toggle">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={disabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />
          <span><Target size={15} /> Goal 独立验收</span>
        </label>
        <button type="button" onClick={onClose} aria-label="收起 Goal 配置" title="收起 Goal 配置">
          <X size={14} />
        </button>
      </div>

      {currentGoal ? (
        <div className={`cc-goal-current cc-goal-current--${currentGoal.status}`}>
          <strong>{goalStatusLabel(currentGoal.status)}</strong>
          <span>{currentGoal.condition}</span>
          <small>独立验收 {currentGoal.recheckCount + (currentGoal.lastVerdict ? 1 : 0)} 次 · 允许续跑 {currentGoal.recheckCount}/{currentGoal.maxRechecks}</small>
        </div>
      ) : null}

      {draft.enabled ? (
        <div className="cc-goal-editor__body">
          <label className="cc-goal-field cc-goal-field--wide">
            <span>目标条件</span>
            <textarea
              value={draft.condition}
              disabled={disabled}
              rows={2}
              maxLength={2000}
              placeholder="留空时使用当前消息作为 Goal"
              onChange={(event) => onChange({ condition: event.target.value })}
            />
          </label>
          <label className="cc-goal-field cc-goal-field--wide">
            <span>验收标准（每行一条）</span>
            <textarea
              value={draft.acceptanceCriteriaText}
              disabled={disabled}
              rows={2}
              placeholder={'例如：\n分析步骤完成\n结论有工具或 Artifact 证据'}
              onChange={(event) => onChange({ acceptanceCriteriaText: event.target.value })}
            />
          </label>
          <label className="cc-goal-field">
            <span>最大续跑次数</span>
            <input
              type="number"
              min={0}
              max={10}
              step={1}
              value={draft.maxRechecks}
              disabled={disabled}
              onChange={(event) => onChange({ maxRechecks: event.target.value })}
            />
          </label>
          <label className="cc-goal-field">
            <span>词元预算</span>
            <input
              type="number"
              min={1}
              max={10_000_000}
              step={1}
              value={draft.maxTokenBudget}
              disabled={disabled}
              placeholder="不限制"
              onChange={(event) => onChange({ maxTokenBudget: event.target.value })}
            />
          </label>
          <label className="cc-goal-field cc-goal-field--wide">
            <span>截止时间</span>
            <input
              type="datetime-local"
              value={draft.deadlineLocal}
              disabled={disabled}
              onChange={(event) => onChange({ deadlineLocal: event.target.value })}
            />
          </label>
          <p className="cc-goal-editor__note">最终回答会先持久化，再由无工具权限的独立模型根据真实账本验收；未满足时只在上述边界内续跑。</p>
        </div>
      ) : (
        <p className="cc-goal-editor__note">启用后，运行不会仅凭工作 Agent 自称完成而结束。</p>
      )}
      {error ? <p className="cc-goal-editor__error" role="alert">{error}</p> : null}
    </section>
  )
}

function goalStatusLabel(status: NonNullable<ChatPanelProps['goal']>['status']): string {
  const labels: Record<NonNullable<ChatPanelProps['goal']>['status'], string> = {
    active: 'Goal 执行中',
    evaluating: 'Goal 验收中',
    satisfied: 'Goal 已满足',
    impossible: 'Goal 不可达',
    exhausted: 'Goal 边界耗尽',
    cancelled: 'Goal 已取消',
    failed: 'Goal 验收失败',
  }
  return labels[status]
}

function ComposerModeIcon({
  mode,
  className,
  size,
}: {
  mode: ComposerMode | 'bypass'
  className?: string
  size: number
}) {
  if (mode === 'approval') return <Hand className={className} size={size} />
  if (mode === 'plan') return <ClipboardList className={className} size={size} />
  if (mode === 'bypass') return <ShieldOff className={className} size={size} />
  return <Zap className={className} size={size} />
}

function SpeechInputControl({
  status,
  error,
  language,
  languages,
  disabled,
  onLanguageChange,
  onStart,
  onStop,
}: {
  status: SpeechRecognitionStatus
  error?: string | null
  language: string
  languages: SpeechLanguageOption[]
  disabled: boolean
  onLanguageChange?: (language: string) => void
  onStart?: () => void
  onStop?: () => void
}) {
  const busy = status === 'authorizing' || status === 'stopping'
  const active = status === 'recognizing' || busy
  const Icon = busy ? LoaderCircle : active ? MicOff : Mic
  const label = active ? '停止语音输入' : '开始语音输入'
  return (
    <div className="cc-speech-control">
      <button
        className={`cc-composer-tool cc-composer-tool--speech${active ? ' cc-composer-tool--speech-active' : ''}${error ? ' cc-composer-tool--speech-error' : ''}`}
        type="button"
        disabled={disabled || busy}
        title={label}
        aria-label={label}
        onClick={() => active ? onStop?.() : onStart?.()}
      >
        <Icon size={16} className={busy ? 'cc-spin' : undefined} />
      </button>
      {languages.length > 1 ? (
        <select
          className="cc-speech-language"
          value={language}
          disabled={disabled || active}
          aria-label="语音识别语言"
          onChange={(event) => onLanguageChange?.(event.target.value)}
        >
          {languages.map(option => (
            <option key={option.locale} value={option.locale}>{option.label}</option>
          ))}
        </select>
      ) : null}
    </div>
  )
}

function formatSpeechStatus(status: SpeechRecognitionStatus, interimText?: string, error?: string | null): string {
  if (error) return error
  if (interimText?.trim()) return `正在识别：${interimText.trim()}`
  if (status === 'authorizing') return '正在申请语音授权...'
  if (status === 'recognizing') return '正在听写，识别结果会填入输入框。'
  if (status === 'stopping') return '正在停止语音输入...'
  return ''
}

function AttachmentTray({
  attachments,
  busy,
  onRemove,
}: {
  attachments: RunAttachmentInput[]
  busy: boolean
  onRemove?: (fileId: string) => void
}) {
  if (!attachments.length && !busy) return null
  return (
    <div className="cc-attachment-tray" aria-label="待发送图片附件">
      {attachments.map(attachment => (
        <span key={attachment.fileId} className="cc-attachment-chip">
          <span aria-hidden="true">{attachment.kind === 'map_screenshot' ? '🗺️' : '🖼️'}</span>
          <strong title={attachment.name}>{attachment.name}</strong>
          {onRemove ? (
            <button
              type="button"
              aria-label={`移除附件 ${attachment.name}`}
              onClick={() => onRemove(attachment.fileId)}
            >
              <X size={12} />
            </button>
          ) : null}
        </span>
      ))}
      {busy ? (
        <span className="cc-attachment-chip cc-attachment-chip--busy" role="status">
          <LoaderCircle className="cc-spin" size={13} /> 正在安全附加图片
        </span>
      ) : null}
    </div>
  )
}

function UploadProgressTray({
  references,
  onDismiss,
}: {
  references: UploadReference[]
  onDismiss?: (id: string) => void
}) {
  if (!references.length) return null

  return (
    <div className="cc-upload-tray" aria-label="上传进度">
      {references.map((item) => {
        const progress = uploadProgress(item)
        const state = uploadVisualState(item.status)
        const style = { '--cc-upload-progress': `${Math.round(progress * 360)}deg` } as CSSProperties
        return (
          <div key={item.id} className={`cc-upload-card cc-upload-card--${state}`} role="status">
            <span className="cc-upload-card__icon" style={style} aria-hidden="true">
              <span />
            </span>
            <span className="cc-upload-card__copy">
              <strong title={item.name}>{item.name}</strong>
              <small>{uploadSubtitle(item)}</small>
            </span>
            {onDismiss ? (
              <button
                type="button"
                className="cc-upload-card__close"
                aria-label={`收起 ${item.name} 上传提示`}
                title="收起上传提示"
                onClick={() => onDismiss(item.id)}
              >
                <X size={14} />
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function visibleUploadCards(references: UploadReference[]): UploadReference[] {
  const aggregate = references.find(item => item.isAggregate)
  if (aggregate) return [aggregate]
  return references
    .filter(item => ['uploading', 'queued', 'running', 'failed', 'ready', 'completed'].includes(item.status))
    .slice(-2)
}

function uploadProgress(item: UploadReference): number {
  if (typeof item.progress === 'number' && Number.isFinite(item.progress)) {
    return Math.max(0, Math.min(1, item.progress))
  }
  if (['ready', 'completed', 'failed'].includes(item.status)) return 1
  return 0
}

function uploadVisualState(status: string): 'active' | 'done' | 'failed' {
  if (status === 'failed') return 'failed'
  if (status === 'ready' || status === 'completed') return 'done'
  return 'active'
}

function uploadSubtitle(item: UploadReference): string {
  if (item.detail) return item.detail
  if (item.totalCount && item.totalCount > 1) {
    return `${item.completedCount ?? 0}/${item.totalCount} 个文件`
  }
  if (item.status === 'failed') return '上传失败'
  if (item.status === 'ready' || item.status === 'completed') return '上传完成'
  return '正在上传'
}

function FileUploadButton({
  disabled,
  onUploadFiles,
}: {
  disabled: boolean
  onUploadFiles: (files: DesktopFileSelectionHandle[]) => void
}) {
  const [selectionError, setSelectionError] = useState<string | null>(null)

  const choose = async (kind: 'files' | 'folder') => {
    try {
      setSelectionError(null)
      const files = await selectDesktopUploadFiles(kind)
      if (files.length) onUploadFiles(files)
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : '文件选择失败，请重试。')
    }
  }

  return (
    <span className="cc-composer-native-files">
      <button
        type="button"
        className={`cc-composer-tool${disabled ? ' cc-composer-tool--disabled' : ''}`}
        title="上传文件"
        aria-label="上传文件"
        disabled={disabled}
        onClick={() => { void choose('files') }}
      >
        <Upload size={16} />
      </button>
      <button
        type="button"
        className={`cc-composer-tool${disabled ? ' cc-composer-tool--disabled' : ''}`}
        title="上传文件夹"
        aria-label="上传文件夹"
        disabled={disabled}
        onClick={() => { void choose('folder') }}
      >
        <FolderUp size={16} />
      </button>
      {selectionError ? (
        <span className="cc-native-file-error" role="alert">{selectionError}</span>
      ) : null}
    </span>
  )
}

function ComposerDiagnostics({
  tokenBudget,
  activeSkills,
  activeMcpServers,
  compactionLevel,
  runStats,
  denialCounts,
  goal,
}: {
  tokenBudget?: ChatPanelProps['tokenBudget']
  activeSkills?: string[]
  activeMcpServers?: string[]
  compactionLevel?: string | null
  runStats?: ChatPanelProps['runStats']
  denialCounts?: Record<string, number>
  goal?: ChatPanelProps['goal']
}) {
  const denialTotal = Object.values(denialCounts ?? {}).reduce((sum, value) => sum + value, 0)
  if (!tokenBudget && !activeSkills?.length && !activeMcpServers?.length && !compactionLevel && !runStats && !denialTotal && !goal) return null

  return (
    <div className="cc-composer-diagnostics" aria-label="运行诊断摘要">
      {tokenBudget ? <span>上下文 {Math.round((tokenBudget.used / tokenBudget.max) * 100)}%</span> : null}
      {activeSkills?.length ? <span>技能 {activeSkills.length}</span> : null}
      {activeMcpServers?.length ? <span>MCP {activeMcpServers.length}</span> : null}
      {compactionLevel ? <span>压缩 {compactionLevel}</span> : null}
      {runStats ? <span>工具 {runStats.toolSuccesses}/{runStats.toolAttempts}</span> : null}
      {denialTotal ? <span>拒绝 {denialTotal}</span> : null}
      {goal ? <span title={goal.lastVerdict?.reason ?? goal.failureReason ?? goal.condition}>{goalStatusLabel(goal.status)} {goal.recheckCount}/{goal.maxRechecks}</span> : null}
    </div>
  )
}

function ThreadUsageBar({
  usage,
  loading = false,
  unavailable = false,
  active,
}: {
  usage?: ChatPanelProps['threadUsage']
  loading?: boolean
  unavailable?: boolean
  active: boolean
}) {
  if (unavailable && !usage) {
    return (
      <div className="cc-thread-usage cc-thread-usage--unavailable" role="status">
        <span className="cc-thread-usage__title">本对话累计</span>
        <span>词元统计暂不可用</span>
      </div>
    )
  }

  const inputTokens = usage?.inputTokens ?? 0
  const outputTokens = usage?.outputTokens ?? 0
  const totalTokens = usage?.totalTokens ?? 0
  const cacheHitInputTokens = usage?.cacheHitInputTokens ?? 0
  const cacheMeasuredInputTokens = usage?.cacheMeasuredInputTokens ?? 0
  const cacheRate = cacheMeasuredInputTokens > 0
    ? `${formatPercent(cacheHitInputTokens / cacheMeasuredInputTokens)}%`
    : null

  return (
    <div
      className={`cc-thread-usage${active ? ' cc-thread-usage--active' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="当前对话累计词元"
      title="缓存数据只采用供应商返回的用量明细；本机不估算命中数"
    >
      <span className="cc-thread-usage__title"><i aria-hidden="true" />本对话累计</span>
      <span>输入 <strong>{formatTokenCount(inputTokens)}</strong></span>
      <span>输出 <strong>{formatTokenCount(outputTokens)}</strong></span>
      <span>合计 <strong>{formatTokenCount(totalTokens)}</strong></span>
      <span>供应商缓存 {cacheRate
        ? <><strong>{formatTokenCount(cacheHitInputTokens)}</strong> · {cacheRate}</>
        : <strong>未报告</strong>}
      </span>
      {loading ? <span className="cc-thread-usage__state">更新中</span> : null}
      {unavailable ? (
        <span className="cc-thread-usage__state cc-thread-usage__state--stale">统计可能已过期</span>
      ) : null}
    </div>
  )
}

function formatTokenCount(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString('zh-CN')
}

function formatPercent(value: number): string {
  return (Math.max(0, Math.min(1, value)) * 100).toFixed(2).replace(/\.?0+$/u, '')
}

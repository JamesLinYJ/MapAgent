// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型 Provider 配置向导
//
//   文件:       ProviderSetupWizard.tsx
//
//   日期:       2026年08月28日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { zodResolver } from '@hookform/resolvers/zod'
import {
  customProviderConfigSchema,
  type CustomProviderRecord,
  type CustomProviderSaveResult,
  type CustomProviderTestMode,
  type ProviderDiscoveredModel,
} from '@geo-agent-platform/shared-types'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  Controller,
  useFieldArray,
  useForm,
  useWatch,
  type FieldError,
} from 'react-hook-form'
import { z } from 'zod'

import {
  discoverCustomProviderModels,
  saveCustomProvider,
  stageProviderCredential,
  testCustomProvider,
} from '../../api/client'
import { PlatformTransportError } from '../../api/errors'
import { requireDesktopBridge } from '../../api/transport'
import { formatZodError } from '../../shared/components/FormField'
import {
  GlassDialog,
  GlassDialogActions,
} from '../../shared/components/GlassDialog'
import {
  PROVIDER_TEMPLATES,
  createModelSnapshot,
  createProviderRecordValues,
  createProviderTemplateValues,
  inferProviderTemplate,
  providerTemplate,
  type ProviderTemplateId,
  type ProviderWizardValues,
} from './providerTemplates'
import { providerTestNotice } from './providerTestPresentation'

const providerWizardSchema = z.object({
  config: customProviderConfigSchema,
  apiKey: z.string().max(8_192, '访问密钥长度不能超过 8192 个字符'),
  clearApiKey: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.apiKey && value.clearApiKey) {
    context.addIssue({
      code: 'custom',
      path: ['clearApiKey'],
      message: '新访问密钥与清除操作不能同时使用',
    })
  }
  if (value.config.providerId === 'anthropic' || value.config.providerId === 'gemini') {
    context.addIssue({
      code: 'custom',
      path: ['config', 'providerId'],
    message: `内置模型服务“${value.config.providerId}”不允许由设置页覆盖`,
    })
  }
})

type WizardStep = 1 | 2 | 3 | 4

export interface ProviderSetupWizardProps {
  open: boolean
  record?: CustomProviderRecord | null
  initialTemplate?: ProviderTemplateId
  mode?: 'settings' | 'onboarding'
  onClose: () => void
  onSaved: (result: CustomProviderSaveResult) => void | Promise<void>
}

export function ProviderSetupWizard({
  open,
  record = null,
  initialTemplate,
  mode = 'settings',
  onClose,
  onSaved,
}: ProviderSetupWizardProps) {
  const initialTemplateId = record
    ? inferProviderTemplate(record.providerId)
    : initialTemplate ?? 'custom'
  const [templateId, setTemplateId] = useState<ProviderTemplateId>(initialTemplateId)
  const [step, setStep] = useState<WizardStep>(record || initialTemplate ? 2 : 1)
  const [showApiKey, setShowApiKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [discoveredModels, setDiscoveredModels] = useState<ProviderDiscoveredModel[]>([])
  const form = useForm<ProviderWizardValues>({
    resolver: zodResolver(providerWizardSchema),
    defaultValues: record
      ? createProviderRecordValues(record)
      : createProviderTemplateValues(initialTemplateId),
    mode: 'onBlur',
  })
  const {
    control,
    formState: { errors, isDirty },
    getValues,
    handleSubmit,
    register,
    reset,
    setValue,
    trigger,
  } = form
  const { fields, append, remove, replace } = useFieldArray({ control, name: 'config.models' })
  const watchedConfig = useWatch({ control, name: 'config' })
  const watchedApiKey = useWatch({ control, name: 'apiKey' })
  const watchedClearApiKey = useWatch({ control, name: 'clearApiKey' })
  const template = providerTemplate(templateId)
  const selectedModelIds = useMemo(
    () => new Set((watchedConfig?.models ?? []).map(model => model.modelId).filter(Boolean)),
    [watchedConfig?.models],
  )

  useEffect(() => {
    if (!open) return
    const nextTemplate = record
      ? inferProviderTemplate(record.providerId)
      : initialTemplate ?? 'custom'
    setTemplateId(nextTemplate)
    setStep(record || initialTemplate ? 2 : 1)
    setShowApiKey(false)
    setBusy(false)
    setServerError(null)
    setNotice(null)
    setDiscoveredModels([])
    reset(record ? createProviderRecordValues(record) : createProviderTemplateValues(nextTemplate))
  }, [initialTemplate, open, record, reset])

  const requestClose = async (): Promise<void> => {
    if (busy) return
    if (isDirty) {
      const confirmed = await requireDesktopBridge().dialog.confirm({
        title: '放弃模型服务配置',
        message: '当前填写的内容尚未保存。',
        detail: '关闭后，访问密钥和其他未保存信息都会从当前页面清除。',
        confirmLabel: '放弃并关闭',
        cancelLabel: '继续填写',
        tone: 'danger',
      })
      if (!confirmed) return
    }
    reset(record ? createProviderRecordValues(record) : createProviderTemplateValues(templateId))
    setShowApiKey(false)
    setServerError(null)
    setNotice(null)
    setDiscoveredModels([])
    onClose()
  }

  const chooseTemplate = (nextTemplate: ProviderTemplateId): void => {
    setTemplateId(nextTemplate)
    setDiscoveredModels([])
    setServerError(null)
    setNotice(null)
    reset(createProviderTemplateValues(nextTemplate))
    setStep(2)
  }

  const validateEndpointStep = async (): Promise<boolean> => {
    const valid = await trigger([
      'config.providerId',
      'config.displayName',
      'config.baseUrl',
      'config.protocol',
      'config.toolSchemaMode',
    ])
    return valid
  }

  const discoverModels = async (): Promise<void> => {
    if (!(await validateEndpointStep())) return
    setBusy(true)
    setServerError(null)
    setNotice(null)
    try {
      const values = getValues()
      const staged = values.apiKey.trim()
        ? await stageProviderCredential(values.apiKey)
        : null
      const result = await discoverCustomProviderModels({
        providerId: values.config.providerId,
        baseUrl: values.config.baseUrl,
        credentialHandle: staged?.credentialHandle,
      })
      setDiscoveredModels(result.models)
      const preferred = templateId === 'deepseek'
        ? result.models.find(model => model.modelId === 'deepseek-v4-flash')
        : null
      if (preferred && !selectedModelIds.has(preferred.modelId)) {
        const snapshot = createModelSnapshot(preferred.modelId, templateId)
        replace([snapshot])
        setValue('config.defaultModel', snapshot.modelId, { shouldDirty: true, shouldValidate: true })
      }
      setNotice(`发现 ${result.models.length} 个模型，用时 ${Math.round(result.latencyMs)} ms。`)
      setStep(3)
    } catch (error) {
      setNotice(`模型探测未完成：${safeMessage(error)} 仍可继续手动填写并保存。`)
      setStep(3)
    } finally {
      setBusy(false)
    }
  }

  const skipDiscovery = async (): Promise<void> => {
    if (!(await validateEndpointStep())) return
    setServerError(null)
    setNotice('已跳过自动探测，请手动填写并声明模型能力。')
    setStep(3)
  }

  const addDiscoveredModel = (model: ProviderDiscoveredModel): void => {
    if (fields.length >= 100 || selectedModelIds.has(model.modelId)) return
    append(createModelSnapshot(model.modelId, templateId), { shouldFocus: false })
  }

  const addManualModel = (): void => {
    if (fields.length >= 100) return
    append(createModelSnapshot('', templateId))
  }

  const removeModel = (index: number): void => {
    const current = getValues(`config.models.${index}`)
    remove(index)
    if (current?.modelId && getValues('config.defaultModel') === current.modelId) {
      setValue('config.defaultModel', '', { shouldDirty: true, shouldValidate: true })
    }
  }

  const review = async (): Promise<void> => {
    const valid = await trigger(['config.models', 'config.defaultModel'])
    if (valid) setStep(4)
  }

  const testProvider = async (mode: CustomProviderTestMode): Promise<void> => {
    const valid = await trigger('config')
    if (!valid) return
    setBusy(true)
    setServerError(null)
    setNotice(null)
    try {
      const values = getValues()
      const staged = values.apiKey.trim()
        ? await stageProviderCredential(values.apiKey)
        : null
      const result = await testCustomProvider({
        config: values.config,
        mode,
        credentialHandle: staged?.credentialHandle,
      })
      setNotice(providerTestNotice(result))
    } catch (error) {
      setNotice(`测试未通过：${safeMessage(error)} 这不会阻止保存。`)
    } finally {
      setBusy(false)
    }
  }

  const save = handleSubmit(async values => {
    setBusy(true)
    setServerError(null)
    try {
      const staged = values.apiKey.trim()
        ? await stageProviderCredential(values.apiKey)
        : null
      const result = await saveCustomProvider({
        config: values.config,
        expectedRevision: record?.revision ?? null,
        credentialHandle: staged?.credentialHandle,
        clearApiKey: values.clearApiKey,
      })
      reset(createProviderTemplateValues(templateId))
      await onSaved(result)
    } catch (error) {
      setServerError(error instanceof PlatformTransportError && error.code === 'version_conflict'
        ? '该模型服务已在另一个窗口更新，当前草稿已保留。请关闭后重新打开最新配置，再合并修改。'
        : safeMessage(error))
    } finally {
      setValue('apiKey', '', { shouldDirty: false })
      setShowApiKey(false)
      setBusy(false)
    }
  })

  return (
    <GlassDialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) void requestClose()
      }}
      title={record ? `编辑 ${record.displayName}` : mode === 'onboarding' ? '配置第一个模型服务' : '添加模型服务'}
      description="访问密钥经一次性凭据句柄提交，由服务端原文保存在数据库；不会回传或写入界面持久存储。"
      variant="provider-wizard"
    >
      <button
        type="button"
        className="provider-wizard__close"
        aria-label="关闭配置向导"
        disabled={busy}
        onClick={() => { void requestClose() }}
      >
        <X size={17} />
      </button>

      <nav className="provider-wizard__steps" aria-label="模型服务配置进度">
        {(['模板', '连接', '模型', '确认'] as const).map((label, index) => {
          const candidate = (index + 1) as WizardStep
          return (
            <span key={label} data-state={candidate === step ? 'active' : candidate < step ? 'done' : 'pending'}>
              <i>{candidate < step ? <Check size={12} /> : candidate}</i>{label}
            </span>
          )
        })}
      </nav>

      <form className="provider-wizard" onSubmit={event => { void save(event) }}>
        {step === 1 ? (
          <section className="provider-wizard__template-grid" aria-label="选择模型服务模板">
            {PROVIDER_TEMPLATES.map(candidate => (
              <button key={candidate.id} type="button" onClick={() => chooseTemplate(candidate.id)}>
                <ServerCog size={20} />
                <strong>{candidate.label}</strong>
                <small>{candidate.description}</small>
                <code>{candidate.endpointHint}</code>
              </button>
            ))}
          </section>
        ) : null}

        {step === 2 ? (
          <section className="provider-wizard__panel">
            <div className="provider-wizard__panel-heading">
              <div><strong>{template.label} 连接信息</strong><small>编辑已有配置时，访问密钥留空会保留原值。</small></div>
              {!record ? <button type="button" onClick={() => setStep(1)}>更换模板</button> : null}
            </div>
            <div className="provider-wizard__fields">
              <label>
                <span>服务标识</span>
                <input
                  {...register('config.providerId')}
                  disabled={Boolean(record) || template.providerIdLocked}
                  placeholder="my-provider"
                />
                <FieldMessage error={errors.config?.providerId} />
              </label>
              <label>
                <span>显示名称</span>
                <input {...register('config.displayName')} placeholder="我的模型服务" />
                <FieldMessage error={errors.config?.displayName} />
              </label>
              <label className="is-wide">
                <span>接口地址</span>
                <input {...register('config.baseUrl')} type="url" placeholder={template.endpointHint} />
                <FieldMessage error={errors.config?.baseUrl} />
              </label>
              <label>
                <span>接口协议</span>
                <select {...register('config.protocol')}>
                  <option value="responses">响应接口</option>
                  <option value="chat_completions">对话补全接口</option>
                </select>
              </label>
              <label>
                <span>工具参数格式</span>
                <select {...register('config.toolSchemaMode')}>
                  <option value="compatible">兼容模式</option>
                  <option value="strict">严格模式</option>
                </select>
              </label>
              <label className="provider-wizard__secret">
                <span>访问密钥 {template.apiKeyRecommended ? '（通常需要，可留空尝试）' : '（可选）'}</span>
                <span>
                  <KeyRound size={15} />
                  <input
                    {...register('apiKey')}
                    type={showApiKey ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={watchedClearApiKey}
                    placeholder={record?.hasApiKey ? '留空则保留已保存密钥' : '输入新的访问密钥'}
                  />
                  <button type="button" aria-label={showApiKey ? '隐藏访问密钥' : '显示访问密钥'} onClick={() => setShowApiKey(value => !value)}>
                    {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </span>
                <FieldMessage error={errors.apiKey} />
              </label>
            </div>
            {record?.hasApiKey ? (
              <label className="provider-wizard__clear-secret">
                <input {...register('clearApiKey')} type="checkbox" disabled={Boolean(watchedApiKey?.trim())} />
                清除已保存的访问密钥；可在保存前另行测试服务是否支持无密钥调用。
              </label>
            ) : null}
            <p className="provider-wizard__boundary-note">
              HTTP 和 HTTPS 均可使用，不限制本机、局域网或公网地址；是否可用以实际调用结果为准。
            </p>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="provider-wizard__panel">
            <div className="provider-wizard__panel-heading">
              <div><strong>模型与智能体能力</strong><small>最多保存 100 个模型；能力按服务实际情况自由声明，不参与保存拦截。</small></div>
              <button type="button" disabled={fields.length >= 100} onClick={addManualModel}>
                <Plus size={13} />手动添加
              </button>
            </div>

            {discoveredModels.length ? (
              <div className="provider-wizard__discovered">
                <strong>自动发现</strong>
                <div>
                  {discoveredModels.map(model => (
                    <button
                      key={model.modelId}
                      type="button"
                      disabled={selectedModelIds.has(model.modelId) || fields.length >= 100}
                      onClick={() => addDiscoveredModel(model)}
                    >
                      {selectedModelIds.has(model.modelId) ? <Check size={12} /> : <Plus size={12} />}
                      {model.modelId}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="provider-wizard__model-list">
              {fields.map((field, index) => {
                const model = watchedConfig?.models?.[index]
                return (
                  <article key={field.id}>
                    <div className="provider-wizard__model-main">
                      <label>
                        <span>模型 ID</span>
                        <input {...register(`config.models.${index}.modelId`)} placeholder="model-id" />
                        <FieldMessage error={errors.config?.models?.[index]?.modelId} />
                      </label>
                      <label>
                        <span>上下文词元</span>
                        <input
                          {...register(`config.models.${index}.contextWindowTokens`, { valueAsNumber: true })}
                          type="number"
                          min={1_024}
                          max={10_000_000}
                        />
                        <FieldMessage error={errors.config?.models?.[index]?.contextWindowTokens} />
                      </label>
                      <label className="provider-wizard__default-model">
                        <input
                          {...register('config.defaultModel')}
                          type="radio"
                          value={model?.modelId ?? ''}
                          disabled={!model?.modelId}
                        />
                        默认模型
                      </label>
                      <button type="button" aria-label={`删除模型 ${model?.modelId || index + 1}`} onClick={() => removeModel(index)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <details>
                      <summary>高级能力</summary>
                      <div className="provider-wizard__model-options">
                        <fieldset>
                          <legend>输入模态</legend>
                          <Controller
                            control={control}
                            name={`config.models.${index}.modalities`}
                            render={({ field: modalitiesField }) => (
                              <>
                                {(['text', 'image', 'audio', 'pdf'] as const).map(modality => (
                                  <label key={modality}>
                                    <input
                                      type="checkbox"
                                      checked={modalitiesField.value.includes(modality)}
                                      disabled={modality === 'text'}
                                      onChange={event => modalitiesField.onChange(event.target.checked
                                        ? [...modalitiesField.value, modality]
                                        : modalitiesField.value.filter(value => value !== modality))}
                                    />
                                    {modalityLabel(modality)}
                                  </label>
                                ))}
                              </>
                            )}
                          />
                        </fieldset>
                        <fieldset>
                          <legend>智能体能力</legend>
                          <label><input {...register(`config.models.${index}.capabilities.reasoning`)} type="checkbox" />推理</label>
                          <label><input {...register(`config.models.${index}.capabilities.structuredOutput`)} type="checkbox" />结构化输出</label>
                          <label><input {...register(`config.models.${index}.capabilities.toolCalls`)} type="checkbox" />工具调用</label>
                        </fieldset>
                      </div>
                    </details>
                  </article>
                )
              })}
              {!fields.length ? (
                <div className="provider-wizard__empty">尚未选择模型。可从发现结果添加，或手动填写模型 ID。</div>
              ) : null}
            </div>
            <FieldMessage error={errors.config?.defaultModel} />
          </section>
        ) : null}

        {step === 4 ? (
          <section className="provider-wizard__panel provider-wizard__review">
            <div className="provider-wizard__review-icon"><ServerCog size={24} /></div>
            <div>
              <span>模型服务</span><strong>{watchedConfig?.displayName}</strong><code>{watchedConfig?.providerId}</code>
            </div>
            <div><span>端点</span><strong>{watchedConfig?.baseUrl}</strong></div>
            <div><span>接口协议</span><strong>{watchedConfig?.protocol === 'responses' ? '响应接口' : '对话补全接口'}</strong></div>
            <div><span>默认模型</span><strong>{watchedConfig?.defaultModel}</strong></div>
            <div><span>模型数量</span><strong>{watchedConfig?.models?.length ?? 0}</strong></div>
            <div>
              <span>访问密钥</span>
              <strong>{watchedClearApiKey
                ? '保存时清除'
                : watchedApiKey?.trim()
                  ? '将替换为新密钥'
                  : record?.hasApiKey
                    ? '保留已保存密钥'
                    : '未提供'}</strong>
            </div>
            <div className="provider-wizard__optional-tests">
              <div>
                <strong>保存前测试（可选）</strong>
                <small>测试与保存互不依赖；失败只作提醒，不会阻止保存。</small>
              </div>
              <div>
                <button type="button" disabled={busy} onClick={() => { void testProvider('connectivity') }}>测试连接</button>
                <button type="button" disabled={busy} onClick={() => { void testProvider('models') }}>获取模型</button>
                <button type="button" disabled={busy} onClick={() => { void testProvider('model_call') }}>测试模型调用</button>
              </div>
            </div>
            <p>自动探测和以上测试都可以跳过；保存只校验当前表单字段，不会主动联网。</p>
          </section>
        ) : null}

        {notice ? <p className="provider-wizard__notice" role="status">{notice}</p> : null}
        {serverError ? <p className="provider-wizard__error" role="alert">{serverError}</p> : null}

        <GlassDialogActions>
          {step > 1 ? (
            <button type="button" disabled={busy} onClick={() => setStep(value => Math.max(1, value - 1) as WizardStep)}>
              <ArrowLeft size={14} />上一步
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => { void requestClose() }}>
              {mode === 'onboarding' ? '稍后配置' : '取消'}
            </button>
          )}
          {step === 2 ? (
            <>
              <button type="button" disabled={busy} onClick={() => { void skipDiscovery() }}>手动填写模型</button>
              <button type="button" className="is-primary" disabled={busy} onClick={() => { void discoverModels() }}>
                {busy ? <LoaderCircle className="is-spinning" size={14} /> : <RefreshCw size={14} />}
                {busy ? '正在探测…' : '自动探测模型'}
              </button>
            </>
          ) : step === 3 ? (
            <button type="button" className="is-primary" disabled={busy || !fields.length} onClick={() => { void review() }}>
              查看确认 <ArrowRight size={14} />
            </button>
          ) : step === 4 ? (
            <button type="submit" className="is-primary" disabled={busy}>
              {busy ? <LoaderCircle className="is-spinning" size={14} /> : <Check size={14} />}
              {busy ? '正在保存…' : '保存配置'}
            </button>
          ) : null}
        </GlassDialogActions>
      </form>
    </GlassDialog>
  )
}

function FieldMessage({ error }: { error?: FieldError }): React.JSX.Element | null {
  const message = formatZodError(error)
  return message ? <small className="provider-wizard__field-error" role="alert">{message}</small> : null
}

function modalityLabel(modality: 'text' | 'image' | 'audio' | 'pdf'): string {
  if (modality === 'text') return '文本'
  if (modality === 'image') return '图片'
  if (modality === 'audio') return '音频'
  return 'PDF'
}

function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.replace(/[\r\n]+/gu, ' ').slice(0, 800)
  }
  return '模型服务操作失败，请稍后重试。'
}

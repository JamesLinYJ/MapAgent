// +-------------------------------------------------------------------------
//
//   地理智能平台 - 分步登录页
//
//   文件:       LoginScreen.tsx
//
//   日期:       2026年07月02日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { useState, type FormEvent, type ReactNode } from 'react'
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  CloudSun,
  Database,
  KeyRound,
  LockKeyhole,
  Mail,
  Map,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-react'
import { normalizeApiErrorMessage } from '../../api/errors'
import { signInWithEmail, signUpWithEmail } from '../../api/authClient'
import { canSubmitLoginStep, isValidEmail, type LoginFormState, type LoginStep } from './loginModel'
import { requestDesktopDocument } from '../desktopNavigation'

export interface LoginScreenProps {
  errorMessage?: string
  onAuthenticated: () => void
  initialStep?: LoginStep
  initialEmail?: string
  signIn?: typeof signInWithEmail
  signUp?: typeof signUpWithEmail
}

export function LoginScreen({
  errorMessage,
  onAuthenticated,
  initialStep = 'email',
  initialEmail = '',
  signIn = signInWithEmail,
  signUp = signUpWithEmail,
}: LoginScreenProps) {
  const [step, setStep] = useState<LoginStep>(initialStep)
  const [name, setName] = useState('')
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [localError, setLocalError] = useState<string>()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const state: LoginFormState = { step, name, email, password }
  const visibleError = localError ?? (errorMessage ? normalizeApiErrorMessage(errorMessage, errorMessage) : undefined)
  const emailReady = isValidEmail(email)
  const canSubmit = canSubmitLoginStep(state) && !isSubmitting

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLocalError(undefined)

    if (step === 'email') {
      if (!emailReady) {
        setLocalError('请输入有效的邮箱地址。')
        return
      }
      setPassword('')
      setStep('password')
      return
    }

    if (!canSubmitLoginStep(state)) {
      setLocalError(step === 'signup' ? '请填写名称、邮箱和至少 12 位密码。' : '请输入至少 12 位密码。')
      return
    }

    setIsSubmitting(true)
    try {
      if (step === 'signup') {
        await signUp({ name: name.trim(), email: email.trim(), password })
      } else if (step === 'password') {
        await signIn(email.trim(), password)
      }
      onAuthenticated()
    } catch (error) {
      setLocalError(normalizeApiErrorMessage(error, '认证请求失败。'))
    } finally {
      setIsSubmitting(false)
    }
  }

  function goEmail() {
    setLocalError(undefined)
    setPassword('')
    setStep('email')
  }

  function goSignup() {
    setLocalError(undefined)
    setStep('signup')
  }

  function goOptions() {
    setLocalError(undefined)
    setStep('options')
  }

  return (
    <main className="digital-cartographer dc-auth-screen">
      <div className="dc-entry-shell" aria-label="地理智能工作台启动入口">
        <section className="dc-entry-hero" aria-labelledby="platform-entry-title">
          <div className="dc-entry-brand">
            <span className="dc-entry-brand__mark" aria-hidden="true">G</span>
            <span>
              <strong>气象空间分析</strong>
              <small>气象空间智能平台</small>
            </span>
          </div>

          <div className="dc-entry-copy">
            <h1 id="platform-entry-title">地理智能工作台</h1>
            <p>统一气象数据、地图浏览、智能工具、自动化流程和安全管理，用可审计的方式完成从上传到结果交付的完整分析链路。</p>
          </div>

          <div className="dc-entry-command-grid" aria-label="平台核心能力">
            <FeatureCard icon={<CloudSun size={20} />} title="气象分析" description="NetCDF、雷达、短临预报和报告输出" />
            <FeatureCard icon={<Map size={20} />} title="地图浏览" description="图层管理、空间查询和结果制图" />
            <FeatureCard icon={<Bot size={20} />} title="智能指令" description="审批、计划模式、工具调用和连续对话" />
            <FeatureCard icon={<Database size={20} />} title="数据治理" description="用量统计、权限审计和可追踪成果文件" />
          </div>

          <div className="dc-entry-preview" aria-label="启动预览">
            <div className="dc-entry-preview__top">
              <span><Activity size={15} aria-hidden="true" /> 实时工作区</span>
              <strong>Ready</strong>
            </div>
            <div className="dc-entry-preview__canvas" aria-hidden="true">
              <span className="dc-entry-preview__map-line dc-entry-preview__map-line--one" />
              <span className="dc-entry-preview__map-line dc-entry-preview__map-line--two" />
              <span className="dc-entry-preview__pulse dc-entry-preview__pulse--a" />
              <span className="dc-entry-preview__pulse dc-entry-preview__pulse--b" />
              <span className="dc-entry-preview__station">07:30</span>
              <span className="dc-entry-preview__legend">57.6 dBZ</span>
            </div>
            <div className="dc-entry-preview__rail">
              <span>上传气象数据</span>
              <span>工具链执行</span>
              <span>生成图层与报告</span>
            </div>
          </div>

          <div className="dc-entry-links" aria-label="法律与隐私链接">
            <button type="button" onClick={() => requestDesktopDocument('terms')}>服务协议</button>
            <button type="button" onClick={() => requestDesktopDocument('privacy')}>隐私政策</button>
          </div>
        </section>

        <section className="dc-auth-panel" aria-labelledby="geo-agent-platform-login-panel-title">
          <div className="dc-auth-card-head">
            <span className="dc-auth-card-head__icon" aria-hidden="true">
              {step === 'signup' ? <UserRound size={21} /> : step === 'options' ? <KeyRound size={21} /> : <LockKeyhole size={21} />}
            </span>
            <span>
              <strong>{step === 'options' ? '登录选项' : step === 'signup' ? '创建账户' : '安全登录'}</strong>
              <small>Better Auth 会话保护 · Casbin 权限控制</small>
            </span>
          </div>

          <div className="dc-auth-step">
            <h2 id="geo-agent-platform-login-panel-title">{stepTitle(step)}</h2>
            <p>{stepDescription(step)}</p>
          </div>

          {visibleError ? <p className="dc-auth-card__error" role="alert">{visibleError}</p> : null}

          {step === 'options' ? (
            <div className="dc-auth-options" aria-label="登录选项列表">
              <button type="button" onClick={goEmail}>
                <Mail size={20} aria-hidden="true" />
                <span><strong>邮箱密码登录</strong><small>使用工作台账号继续访问。</small></span>
                <ArrowRight size={17} aria-hidden="true" />
              </button>
              <button type="button" onClick={goSignup}>
                <ShieldCheck size={20} aria-hidden="true" />
                <span><strong>创建工作台账号</strong><small>注册后会自动创建个人工作区。</small></span>
                <ArrowRight size={17} aria-hidden="true" />
              </button>
              <div className="dc-auth-options__note">
                <CheckCircle2 size={18} aria-hidden="true" />
                <span>如果账号被禁用或缺少权限，请联系平台管理员处理。</span>
              </div>
            </div>
          ) : (
            <form className="dc-auth-card__form" onSubmit={event => void handleSubmit(event)}>
              {step === 'signup' ? (
                <label className="dc-auth-field">
                  <span>名称</span>
                  <input
                    value={name}
                    onChange={event => setName(event.target.value)}
                    autoComplete="name"
                    placeholder="你的名称"
                    required
                  />
                </label>
              ) : null}

              <label className="dc-auth-field">
                <span>邮箱</span>
                <input
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  readOnly={step === 'password'}
                  required
                />
              </label>

              {step === 'password' || step === 'signup' ? (
                <label className="dc-auth-field">
                  <span>密码</span>
                  <input
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    autoComplete={step === 'signup' ? 'new-password' : 'current-password'}
                    minLength={12}
                    type="password"
                    placeholder="至少 12 位"
                    required
                  />
                </label>
              ) : null}

              {step === 'email' ? (
                <p className="dc-auth-help">没有账户？<button type="button" onClick={goSignup}>创建一个</button></p>
              ) : null}

              <div className="dc-auth-actions">
                {step !== 'email' ? <button type="button" className="dc-auth-button dc-auth-button--ghost" onClick={goEmail}>后退</button> : null}
                <button type="submit" className="dc-auth-button dc-auth-button--primary" disabled={!canSubmit}>
                  {isSubmitting ? '处理中...' : step === 'email' ? '下一步' : step === 'signup' ? '创建账号' : '登录'}
                </button>
              </div>
            </form>
          )}

          <aside className="dc-entry-status" aria-label="启动状态">
            <div>
              <Sparkles size={18} aria-hidden="true" />
              <span>分析服务、地图和工具目录会在登录后按权限加载。</span>
            </div>
            <button type="button" className="dc-auth-options-bar" onClick={step === 'options' ? goEmail : goOptions}>
              <KeyRound size={21} aria-hidden="true" />
              <span>{step === 'options' ? '返回邮箱登录' : '登录选项'}</span>
            </button>
          </aside>
        </section>
      </div>
    </main>
  )
}

interface FeatureCardProps {
  icon: ReactNode
  title: string
  description: string
}

function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <div className="dc-entry-feature">
      <span className="dc-entry-feature__icon" aria-hidden="true">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </div>
  )
}

function stepTitle(step: LoginStep): string {
  if (step === 'password') return '输入密码'
  if (step === 'signup') return '创建工作台账号'
  if (step === 'options') return '选择登录方式'
  return '登录'
}

function stepDescription(step: LoginStep): string {
  if (step === 'password') return '确认密码后进入你的气象分析与地图工作区。'
  if (step === 'signup') return '使用邮箱创建账号，系统会为你准备个人工作区。'
  if (step === 'options') return '当前版本支持邮箱密码登录和公开注册。'
  return '使用工作台账号继续访问气象分析、地图浏览和安全管理功能。'
}

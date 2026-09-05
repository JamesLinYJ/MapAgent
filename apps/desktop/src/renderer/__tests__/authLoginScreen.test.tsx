// +-------------------------------------------------------------------------
//
//   地理智能平台 - 登录页渲染测试
//
//   文件:       authLoginScreen.test.tsx
//
//   日期:       2026年07月02日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'
import { BootScreen } from '../app/AppLoader'
import { LoginScreen } from '../app/auth/LoginScreen'
import { canSubmitLoginStep } from '../app/auth/loginModel'

const noop = () => undefined

function renderLogin(element: ReactElement) {
  return renderToStaticMarkup(element)
}

describe('LoginScreen', () => {
  it('renders the lightweight boot screen with the same entry language', () => {
    const html = renderToStaticMarkup(<BootScreen />)

    expect(html).toContain('正在准备工作台')
    expect(html).toContain('正在加载工作区、地图引擎和本机运行环境')
    expect(html).toContain('启动过程只加载必要组件')
    expect(html).toContain('class="dc-startup"')
  })

  it('renders the email-first Microsoft-style flow without tabs', () => {
    const html = renderLogin(<LoginScreen onAuthenticated={noop} />)

    expect(html).not.toContain(PRODUCT_CODENAME)
    expect(html).toContain('<h1 id="platform-entry-title">地理智能工作台</h1>')
    expect(html).toContain('<h2 id="geo-agent-platform-login-panel-title">登录</h2>')
    expect(html).toContain('气象分析')
    expect(html).toContain('地图浏览')
    expect(html).toContain('服务协议')
    expect(html).toContain('隐私政策')
    expect(html).toContain('placeholder="you@example.com"')
    expect(html).toContain('下一步')
    expect(html).toContain('创建一个')
    expect(html).toContain('登录选项')
    expect(html).not.toContain('role="tablist"')
  })

  it('renders password, signup and options as real states', () => {
    const passwordHtml = renderLogin(
      <LoginScreen onAuthenticated={noop} initialStep="password" initialEmail="user@example.com" />,
    )
    const signupHtml = renderLogin(<LoginScreen onAuthenticated={noop} initialStep="signup" />)
    const optionsHtml = renderLogin(<LoginScreen onAuthenticated={noop} initialStep="options" />)

    expect(passwordHtml).toContain('输入密码')
    expect(passwordHtml).toContain('后退')
    expect(passwordHtml).toContain('disabled=""')
    expect(signupHtml).toContain('创建工作台账号')
    expect(signupHtml).toContain('你的名称')
    expect(optionsHtml).toContain('邮箱密码登录')
    expect(optionsHtml).toContain('联系平台管理员')
  })

  it('keeps submit buttons disabled until each step has enough input', () => {
    expect(canSubmitLoginStep({ step: 'email', name: '', email: 'bad', password: '' })).toBe(false)
    expect(canSubmitLoginStep({ step: 'email', name: '', email: 'user@example.com', password: '' })).toBe(true)
    expect(canSubmitLoginStep({ step: 'password', name: '', email: 'user@example.com', password: 'short' })).toBe(false)
    expect(canSubmitLoginStep({ step: 'password', name: '', email: 'user@example.com', password: 'long-enough-pass' })).toBe(true)
    expect(canSubmitLoginStep({ step: 'signup', name: '', email: 'user@example.com', password: 'long-enough-pass' })).toBe(false)
    expect(canSubmitLoginStep({ step: 'signup', name: 'James', email: 'user@example.com', password: 'long-enough-pass' })).toBe(true)
  })

  it('normalizes proxy failures before rendering auth errors', () => {
    const html = renderLogin(
      <LoginScreen onAuthenticated={noop} errorMessage="Bad Gateway" />,
    )

    expect(html).toContain('工作台 API 未连接，请启动 Node API 服务。')
    expect(html).not.toContain('Bad Gateway')
  })
})

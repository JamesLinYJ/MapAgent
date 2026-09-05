// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机自动认证状态页测试
//
//   文件:       autoAuthScreen.test.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AutoAuthScreen } from '../app/auth/AutoAuthScreen'

describe('AutoAuthScreen', () => {
  it('shows a credential-free bootstrap state instead of a login form', () => {
    const html = renderToStaticMarkup(
      <AutoAuthScreen isChecking errorMessage="后台暂不可用" onRetry={() => undefined} />,
    )

    expect(html).toContain('正在准备工作台')
    expect(html).toContain('后台暂不可用')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('type="password"')
  })

  it('provides an explicit retry after a recoverable failure', () => {
    const html = renderToStaticMarkup(
      <AutoAuthScreen isChecking={false} errorMessage="连接失败" onRetry={() => undefined} />,
    )

    expect(html).toContain('工作台尚未就绪')
    expect(html).toContain('重新启动')
  })
})

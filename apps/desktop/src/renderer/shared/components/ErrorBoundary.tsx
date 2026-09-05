// +-------------------------------------------------------------------------
//
//   地理智能平台 - 全局错误边界
//
//   文件:       ErrorBoundary.tsx
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportClientDiagnostic } from '../utils/clientDiagnostics'
import { StartupScreen } from '../../app/StartupScreen'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientDiagnostic('error', { scope: 'ErrorBoundary', error, detail: info })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <StartupScreen
        stage="界面恢复"
        title="工作台界面需要重新加载"
        description="本机服务和数据不会因此停止；重新加载后会恢复当前工作区。"
        busy={false}
        errorMessage={this.state.error.message || '界面遇到未知错误。'}
        actions={(
          <button
            onClick={() => {
              this.setState({ error: null })
              window.location.reload()
            }}
            type="button"
          >
            重新加载
          </button>
        )}
        footer="如果问题重复出现，可从管理菜单打开系统日志。"
      />
    )
  }
}

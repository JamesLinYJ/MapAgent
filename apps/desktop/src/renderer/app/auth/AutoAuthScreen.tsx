// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机自动认证状态页
//
//   文件:       AutoAuthScreen.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useProductIdentity } from '../ProductIdentityContext'
import { StartupScreen } from '../StartupScreen'

export function AutoAuthScreen({
  errorMessage,
  isChecking,
  onRetry,
}: {
  errorMessage?: string
  isChecking: boolean
  onRetry: () => void
}) {
  const { productName } = useProductIdentity()
  return (
    <StartupScreen
      productName={productName}
      stage="工作区恢复"
      title={isChecking ? '正在准备工作台' : '工作台尚未就绪'}
      description={isChecking
        ? '正在连接本机身份并恢复上次会话，完成后会自动进入。'
        : '本机工作区未能完成初始化，可以立即重试。'}
      busy={isChecking}
      errorMessage={errorMessage}
      actions={!isChecking ? (
        <button type="button" onClick={onRetry}>重新启动</button>
      ) : null}
      footer="本机会话会自动恢复，不需要额外登录或填写连接参数。"
    />
  )
}

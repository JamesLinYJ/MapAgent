// +-------------------------------------------------------------------------
//
//   地理智能平台 - 连接控制器
//
//   文件:       connectionController.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { useModelConnectionStore } from '../stores/modelConnectionStore'

// 连接控制器持有模型 Provider 能力事实和当前用户编辑选择。
//
// 默认 session 获取函数也从这里暴露，AppShell 不直接依赖网络客户端。
export function useConnectionController() {
  const providers = useModelConnectionStore(state => state.providers)
  const provider = useModelConnectionStore(state => state.provider)
  const model = useModelConnectionStore(state => state.model)
  const applyProviders = useModelConnectionStore(state => state.applyProviders)
  const changeProvider = useModelConnectionStore(state => state.changeProvider)
  const setProvider = useModelConnectionStore(state => state.setProvider)
  const setModel = useModelConnectionStore(state => state.setModel)

  return {
    applyProviders,
    changeProvider,
    model,
    provider,
    providers,
    setModel,
    setProvider,
  }
}

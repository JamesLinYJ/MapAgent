// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 本机运行时部署适配
//
//   文件:       packagedLocalRuntime.ts
//
//   日期:       2026年08月12日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// Desktop 与安装后的稳定技术 CLI 必须共享同一套首次部署规则，避免
// 两个入口生成不兼容的端口、密钥或 systemd 配置。
export {
  preparePackagedLocalRuntime,
  readPackagedLocalRuntimeUserSettings,
  updatePackagedLocalRuntimeUserSettings,
} from '@geo-agent-platform/operations-supervisor/packaged-local-runtime'

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地理编码工具 Provider 入口
//
//   文件:       index.ts
//
//   日期:       2026年06月26日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import manifest from './manifest.json' with { type: 'json' };
import { geocodePlaceTool } from './handler.js';
const provider = {
    manifest,
    tools: () => [geocodePlaceTool],
};
export default provider;

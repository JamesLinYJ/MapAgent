// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图表工具 Provider 入口
//
//   文件:       index.ts
//
//   日期:       2026年06月26日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import manifest from "./manifest.json" with { type: "json" };
import { chartTool } from "./chart.js";
const provider = { manifest, tools: () => [chartTool] };
export default provider;

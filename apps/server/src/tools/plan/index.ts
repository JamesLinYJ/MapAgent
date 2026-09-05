// +-------------------------------------------------------------------------
//
//   地理智能平台 - 计划工具 Provider 入口
//
//   文件:       index.ts
//
//   日期:       2026年06月26日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import manifest from "./manifest.json" with { type: "json" };
import { parseToolManifest } from "../../framework/schema.js";
import { enterPlanModeTool, requestClarificationTool, reviseAgentWorkflowTool, submitAgentWorkflowTool } from "./planTools.js";
const provider = { manifest: parseToolManifest(manifest), tools: () => [requestClarificationTool, enterPlanModeTool, submitAgentWorkflowTool, reviseAgentWorkflowTool] };
export default provider;

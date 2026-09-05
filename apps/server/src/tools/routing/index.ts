// +-------------------------------------------------------------------------
//
//   地理智能平台 - 路径规划 ToolProvider
//
//   文件:       index.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------
import manifest from './manifest.json' with { type: 'json' };
import { createRoutePlannerTool } from './routePlanner.js';
export function createRoutingProvider(deps: { valhallaBaseUrl?: string; timeoutMs: number }) {
    return {
        manifest,
        tools: () => [createRoutePlannerTool(deps.valhallaBaseUrl ?? '', deps.timeoutMs)],
    };
}

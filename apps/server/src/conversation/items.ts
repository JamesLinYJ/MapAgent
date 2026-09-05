// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话条目工具
//
//   文件:       items.ts
//
//   日期:       2026年06月26日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

export function summarizeAssistantText(text: string, maxChars = 240): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxChars)
        return normalized;
    return normalized.slice(0, maxChars - 1).trimEnd() + '...';
}

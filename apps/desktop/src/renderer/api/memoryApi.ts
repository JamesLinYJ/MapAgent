// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆 API
//
//   文件:       memoryApi.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
type MemoryFileRecord
} from '@geo-agent-platform/shared-types';

import { requestControl } from './transport';

export type EditableMemoryScope = 'private' | 'team'

export function listMemories(scope?: EditableMemoryScope): Promise<{ records: MemoryFileRecord[]; total: number }> {
  return requestControl('memory:list', { scope })
}

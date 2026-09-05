// +-------------------------------------------------------------------------
//
//   地理智能平台 - 用户决策底部浮层渲染测试
//
//   文件:       decisionSheet.test.tsx
//
//   日期:       2026年07月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DecisionRequest } from '@geo-agent-platform/shared-types'
import { DecisionSheet } from '../features/conversation/DecisionSheet'

describe('DecisionSheet', () => {
  it('标题和问题重复时只保留一个可见标题', () => {
    const html = renderDecisionSheet(decision({
      title: '批准这个智能体工作流？',
      question: '批准这个智能体工作流？',
    }))

    expect(html).not.toContain('cc-decision-sheet__question')
    expect(html).toContain('aria-label="批准这个智能体工作流？"')
  })

  it('问题提供额外决策信息时继续显示', () => {
    const html = renderDecisionSheet(decision({
      title: '需要确认数据范围',
      question: '使用当前会话中的四个文件吗？',
    }))

    expect(html).toContain('cc-decision-sheet__question')
    expect(html).toContain('使用当前会话中的四个文件吗？')
  })
})

function renderDecisionSheet(value: DecisionRequest): string {
  return renderToStaticMarkup(
    <DecisionSheet
      decision={value}
      busy={false}
      reducedMotion
      onSubmit={vi.fn()}
      onClose={vi.fn()}
    />,
  )
}

function decision(overrides: Partial<DecisionRequest>): DecisionRequest {
  return {
    decisionId: 'decision_1',
    kind: 'approval',
    title: overrides.title ?? '需要确认',
    question: overrides.question ?? '请选择下一步。',
    description: '确认后继续执行。',
    options: [{
      optionId: 'approved',
      label: '批准，开始执行',
      description: '继续当前工作流。',
      kind: 'approval',
      reason: null,
      payload: {},
    }],
    allowFreeText: false,
    status: 'pending',
    payload: { defaultOptionId: 'approved' },
    createdAt: '2026-07-20T00:00:00.000Z',
    resolvedAt: null,
  }
}

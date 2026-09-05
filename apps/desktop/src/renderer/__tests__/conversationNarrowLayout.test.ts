// +-------------------------------------------------------------------------
//
//   地理智能平台 - 窄宽对话面板布局守卫
//
//   文件:       conversationNarrowLayout.test.ts
//
//   日期:       2026年08月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const styleRoot = path.resolve(process.cwd(), 'src', 'renderer', 'app', 'styles')
const conversationRoot = path.resolve(process.cwd(), 'src', 'renderer', 'features', 'conversation')

describe('窄宽对话面板布局', () => {
  it('按面板宽度而不是 Electron 窗口宽度重排对话内容', async () => {
    const conversationCss = await readFile(path.join(styleRoot, 'conversation.css'), 'utf8')
    const desktopCss = await readFile(path.join(styleRoot, 'desktop.css'), 'utf8')

    expect(conversationCss).toContain('container-name: conversation-panel;')
    expect(conversationCss).toContain('container-name: conversation-composer;')
    expect(desktopCss).toContain('@container conversation-panel (max-width: 360px)')
    expect(desktopCss).toContain('@container conversation-composer (max-width: 370px)')
  })

  it('停靠式面板不继承整页留白，输入栏使用完整可用宽度', async () => {
    const desktopCss = await readFile(path.join(styleRoot, 'desktop.css'), 'utf8')

    expect(desktopCss).toMatch(/\.gf-assistant-body \.cc-panel\s*\{[^}]*padding:\s*0;/s)
    expect(desktopCss).toMatch(
      /\.gf-assistant-body \.cc-composer\s*\{[^}]*width:\s*calc\(100% - 14px\);/s,
    )
  })

  it('虚拟时间线保留测量高度，不被滚动容器压缩', async () => {
    const conversationCss = await readFile(path.join(styleRoot, 'conversation.css'), 'utf8')

    expect(conversationCss).toMatch(
      /\.cc-timeline__virtual-list\s*\{[^}]*flex:\s*0 0 auto;/s,
    )
  })

  it('对话变化时在绘制前直接定位底部，不重播整段历史', async () => {
    const [timelineSource, scrollControllerSource, conversationCss, legacyCss] = await Promise.all([
      readFile(path.join(conversationRoot, 'ConversationTimeline.tsx'), 'utf8'),
      readFile(path.join(conversationRoot, 'useConversationScrollController.ts'), 'utf8'),
      readFile(path.join(styleRoot, 'conversation.css'), 'utf8'),
      readFile(path.resolve(styleRoot, '..', 'AppShell.css'), 'utf8'),
    ])

    expect(timelineSource).toContain('useConversationScrollController({')
    expect(scrollControllerSource).toContain('useLayoutEffect(() => {')
    expect(scrollControllerSource).toContain('anchorConversationToEnd')
    expect(scrollControllerSource).toContain("behavior: 'auto'")
    expect(timelineSource).toContain("jumpToIndex(targetIndex, reducedMotion ? 'auto' : 'smooth')")
    expect(`${timelineSource}\n${scrollControllerSource}`).not.toContain('nearBottom')
    expect(conversationCss).toMatch(/\.cc-timeline\s*\{[^}]*scroll-behavior:\s*auto;/s)
    expect(legacyCss).not.toMatch(/\.cc-timeline\s*\{[^}]*scroll-behavior:\s*smooth;/s)
  })

  it('同一对话内的新运行不会重建整条时间线', async () => {
    const chatPanelSource = await readFile(path.join(conversationRoot, 'ChatPanel.tsx'), 'utf8')

    expect(chatPanelSource).toContain("key={`chat-${currentThreadId ?? 'idle'}`}")
    expect(chatPanelSource).not.toContain("key={`chat-${currentRunId ?? 'idle'}`}")
  })

  it('极窄输入栏分行排列操作，不让模式与发送按钮相互覆盖', async () => {
    const desktopCss = await readFile(path.join(styleRoot, 'desktop.css'), 'utf8')

    expect(desktopCss).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(desktopCss).toMatch(
      /\.gf-assistant-body \.cc-mode-trigger__label\s*\{\s*display:\s*none;/s,
    )
    expect(desktopCss).toMatch(
      /\.gf-assistant-body \.cc-composer-toolbar__secondary\s*\{[^}]*justify-content:\s*flex-end;/s,
    )
  })

  it('执行方式菜单通过顶层 Portal 渲染，不受停靠面板裁剪边界影响', async () => {
    const composerSource = await readFile(path.join(conversationRoot, 'Composer.tsx'), 'utf8')
    const conversationCss = await readFile(path.join(styleRoot, 'conversation.css'), 'utf8')

    expect(composerSource).toContain('<Popover.Portal>')
    expect(composerSource).toContain('collisionPadding={10}')
    expect(conversationCss).not.toMatch(/\.cc-mode-menu\s*\{[^}]*right:\s*-\d+/s)
    expect(conversationCss).not.toMatch(/\.cc-mode-menu\s*\{[^}]*bottom:\s*calc/s)
  })
})

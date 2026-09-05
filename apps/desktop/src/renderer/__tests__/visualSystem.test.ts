// +-------------------------------------------------------------------------
//
//   地理智能平台 - 视觉系统架构守卫
//
//   文件:       visualSystem.test.ts
//
//   日期:       2026年08月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI ChatGPT:GPT-5.6 Pro
// --------------------------------------------------------------------------

import { readdir,readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe,expect,it } from 'vitest'

const rendererRoot = path.resolve(process.cwd(), 'src', 'renderer')
const repositoryRoot = path.resolve(process.cwd(), '..', '..')

async function readRendererFile(relativePath: string): Promise<string> {
  return readFile(path.join(rendererRoot, relativePath), 'utf8')
}

async function collectRendererTsxFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) return collectRendererTsxFiles(absolutePath)
    return entry.isFile() && entry.name.endsWith('.tsx') ? [absolutePath] : []
  }))
  return nested.flat()
}

async function collectRendererCssFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) return collectRendererCssFiles(absolutePath)
    return entry.isFile() && entry.name.endsWith('.css') ? [absolutePath] : []
  }))
  return nested.flat()
}

async function collectRendererSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : collectRendererSourceFiles(absolutePath)
    return entry.isFile() && /\.(?:html|ts|tsx)$/u.test(entry.name) ? [absolutePath] : []
  }))
  return nested.flat()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

describe('desktop visual system guards', () => {
  it('keeps exactly one liquid-glass displacement material', async () => {
    const [layerSource, generatorSource, assetEntries, rendererTsxFiles] = await Promise.all([
      readRendererFile('shared/components/LiquidGlassLayer.tsx'),
      readFile(path.join(repositoryRoot, 'scripts', 'generate-liquid-glass-maps.mjs'), 'utf8'),
      readdir(path.join(rendererRoot, 'assets', 'liquid-glass')),
      collectRendererTsxFiles(rendererRoot),
    ])

    expect(layerSource).toContain("import surfaceMap from '../../assets/liquid-glass/panel.png'")
    expect(layerSource).toContain("id: 'dc-liquid-glass-surface'")
    expect(layerSource.match(/<filter\b/gu)).toHaveLength(1)
    expect(layerSource).not.toContain('liquid-glass-surface--')
    for (const legacyAsset of ['bar.png', 'chip.png', 'strong.png']) {
      expect(layerSource, legacyAsset).not.toContain(legacyAsset)
    }

    expect(generatorSource).toContain("const OUTPUT_NAME = 'panel.png'")
    expect(generatorSource).toContain("const LEGACY_OUTPUTS = ['bar.png', 'chip.png', 'strong.png']")
    expect(generatorSource).not.toContain('const SPECS')
    expect(assetEntries.filter(name => name.endsWith('.png')).sort()).toEqual(['panel.png'])

    const rendererTsxSources = await Promise.all(
      rendererTsxFiles.map(file => readFile(file, 'utf8')),
    )
    const mountCount = rendererTsxSources.reduce(
      (count, source) => count + (source.match(/<LiquidGlassLayer(?:\s|\/|>)/gu)?.length ?? 0),
      0,
    )
    expect(mountCount).toBe(1)
  })

  it('maps every legacy glass token to the canonical material', async () => {
    const glassSource = await readRendererFile('app/styles/glass.css')

    for (const alias of [
      '--liquid-filter-panel: var(--ui-glass-filter);',
      '--liquid-filter-strong: var(--ui-glass-filter);',
      '--liquid-filter-chip: var(--ui-glass-filter);',
      '--glass-panel-bg: var(--ui-surface);',
      '--glass-strong-bg: var(--ui-surface);',
    ]) {
      expect(glassSource, alias).toContain(alias)
    }
    expect(glassSource).toContain('.liquid-glass-surface,')
    expect(glassSource).toContain('@media (prefers-contrast: more)')
    expect(glassSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(glassSource).toContain('@media (forced-colors: active)')
  })

  it('loads one final semantic theme across every desktop page family', async () => {
    const [
      runtimeSource,
      appShellSource,
      entrySource,
      foundationSource,
      pagesSource,
      contentSource,
      overlaysSource,
    ] = await Promise.all([
      readRendererFile('app/DesktopWorkspaceApplication.tsx'),
      readRendererFile('app/AppShell.tsx'),
      readRendererFile('app/styles/ui-system.css'),
      readRendererFile('app/styles/ui-foundation.css'),
      readRendererFile('app/styles/ui-pages.css'),
      readRendererFile('app/styles/ui-content.css'),
      readRendererFile('app/styles/ui-overlays.css'),
    ])
    const uiSystemSource = [foundationSource, pagesSource, contentSource, overlaysSource].join('\n')

    expect(runtimeSource).toContain("import './styles/ui-system.css'")
    expect(appShellSource).not.toMatch(/import\s+['"][^'"]+\.css['"]/u)
    expect(runtimeSource).toContain('<LiquidGlassLayer />')
    for (const modulePath of [
      '../AppShell.css',
      './glass.css',
      './markdown.css',
      './conversation.css',
      './map.css',
      './layers.css',
      './layout.css',
      './tools-debug.css',
      './settings.css',
      './desktop.css',
      './ui-foundation.css',
      './ui-pages.css',
      './ui-content.css',
      './ui-overlays.css',
    ]) {
      expect(entrySource, modulePath).toContain(`@import '${modulePath}';`)
    }
    expect(runtimeSource.indexOf("import './styles/ui-system.css'"))
      .toBeGreaterThan(runtimeSource.indexOf("import AppShell from './AppShell'"))

    for (const pageRoot of [
      '.gf-desktop-shell',
      '.model-settings',
      '.account-page',
      '.dc-security-page',
      '.debug-shell',
      '.tool-management',
    ]) {
      expect(uiSystemSource, pageRoot).toContain(pageRoot)
    }
    expect(uiSystemSource).toContain('.ui-dialog-surface')
    expect(uiSystemSource).toMatch(/\.ui-dialog-surface\s*\{[\s\S]*?position:\s*fixed;/u)
    expect(uiSystemSource).toMatch(/\.ui-dialog-surface\s*\{[\s\S]*?translate:\s*-50% -50%;/u)
    expect(uiSystemSource).toMatch(/\.ui-dialog-surface::before\s*\{[\s\S]*?inset:\s*0;/u)
    expect(uiSystemSource).toContain('.ui-popover-surface')
    expect(overlaysSource).toMatch(/\.ui-dialog-actions,[\s\S]*?margin:\s*18px 0 0;/u)
    expect(overlaysSource).toMatch(/\.ui-dialog-actions button\s*\{[\s\S]*?min-width:\s*78px;/u)
    expect(uiSystemSource).toContain('@media (prefers-contrast: more)')
    expect(uiSystemSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(uiSystemSource).toContain('@media (forced-colors: active)')
  })

  it('keeps one canonical desktop design specification and page skeleton', async () => {
    const standardsRoot = path.join(repositoryRoot, 'docs', 'standards')
    const [standardEntries, designSource, pageSources] = await Promise.all([
      readdir(standardsRoot),
      readFile(path.join(standardsRoot, 'DESIGN.md'), 'utf8'),
      Promise.all([
        'features/settings/ModelSettingsPage.tsx',
        'features/account/AccountCenterPage.tsx',
        'features/account/LegalPolicyPage.tsx',
        'features/security/SecurityAdminPage.tsx',
        'features/debug/DebugPage.tsx',
        'features/tools/ToolManagementPage.tsx',
      ].map(readRendererFile)),
    ])

    expect(standardEntries.filter(name => /^(?:design|desktop-ui-system)\.md$/iu.test(name))).toEqual(['DESIGN.md'])
    expect(designSource).toContain('data-desktop-platform')
    expect(designSource).toContain('`ui-page-header`')
    expect(designSource).toContain('macOS：左侧至少预留 78 像素')
    for (const source of pageSources) {
      expect(source).toContain('ui-page')
      expect(source).toContain('ui-page-header')
    }
  })

  it('uses glass only for overlays rather than page content', async () => {
    const featureFiles = (await collectRendererTsxFiles(path.join(rendererRoot, 'features')))
      .filter(file => !file.includes(`${path.sep}__tests__${path.sep}`))
    const featureSources = await Promise.all(featureFiles.map(file => readFile(file, 'utf8')))

    expect(featureSources.join('\n')).not.toContain('LiquidGlassSurface')
  })

  it('gives every static semantic component class a CSS selector', async () => {
    const [tsxFiles, cssFiles] = await Promise.all([
      collectRendererTsxFiles(rendererRoot),
      collectRendererCssFiles(rendererRoot),
    ])
    const productionTsxFiles = tsxFiles.filter(file => !file.includes(`${path.sep}__tests__${path.sep}`))
    const [tsxSources, cssSources] = await Promise.all([
      Promise.all(productionTsxFiles.map(file => readFile(file, 'utf8'))),
      Promise.all(cssFiles.map(file => readFile(file, 'utf8'))),
    ])
    const semanticClass = /^(?:account|automation|cc|dc|debug|gf|glass|liquid|model-settings|tool|ui|workbench)-[A-Za-z0-9_-]+$/u
    const classes = new Set<string>()

    for (const source of tsxSources) {
      for (const match of source.matchAll(/className="([^"]+)"/gu)) {
        for (const token of (match[1] ?? '').split(/\s+/u)) {
          if (semanticClass.test(token)) classes.add(token)
        }
      }
    }

    const combinedCss = cssSources.join('\n')
    const missing = [...classes]
      .filter(className => !new RegExp(`\\.${escapeRegExp(className)}(?=[\\s.:#>+~,[{)])`, 'u').test(combinedCss))
      .sort()

    expect(missing).toEqual([])
  })

  it('does not retain the pre-desktop VoiceBar implementation', async () => {
    const [legacySource, conversationSource] = await Promise.all([
      readRendererFile('app/AppShell.css'),
      readRendererFile('app/styles/conversation.css'),
    ])

    expect(legacySource).not.toMatch(/\.voice-(?:bar|trigger)/u)
    for (const selector of [
      '.cc-voice-bar',
      '.cc-voice-bar__copy',
      '.cc-voice-bar__empty',
      '.cc-composer-diagnostics',
      '.cc-system-card__badge',
    ]) {
      expect(conversationSource, selector).toContain(selector)
    }
  })

  it('keeps Markdown code text paired with the final code-block surface', async () => {
    const [markdownSource, contentSource] = await Promise.all([
      readRendererFile('app/styles/markdown.css'),
      readRendererFile('app/styles/ui-content.css'),
    ])

    expect(contentSource).toMatch(/#root pre\s*\{[^}]*color:\s*#243942;[^}]*background:\s*#f5f8f9;/s)
    expect(markdownSource).toMatch(
      /\.markdown-renderer pre code\s*\{[^}]*color:\s*inherit;[^}]*background:\s*transparent;/s,
    )
    expect(markdownSource).not.toMatch(/\.markdown-renderer pre code\s*\{[^}]*text-\[#e5e5ea\]/s)
  })

  it('defines every named desktop animation', async () => {
    const cssFiles = await collectRendererCssFiles(rendererRoot)
    const cssSources = await Promise.all(cssFiles.map(file => readFile(file, 'utf8')))
    const combinedCss = cssSources.join('\n')
    const definitions = new Set(
      [...combinedCss.matchAll(/@(?:-webkit-)?keyframes\s+([_a-zA-Z][\w-]*)/gu)]
        .flatMap(match => match[1] ? [match[1]] : []),
    )
    const references = new Set(
      [...combinedCss.matchAll(/\banimation(?:-name)?\s*:\s*([_a-zA-Z][\w-]*)/gu)]
        .flatMap(match => match[1] ? [match[1]] : [])
        .filter(name => name !== 'none'),
    )

    expect([...references].filter(name => !definitions.has(name)).sort((left, right) => left.localeCompare(right))).toEqual([])
  })

  it('does not retain unreachable legacy AppShell selectors', async () => {
    const [sourceFiles, appShellCss] = await Promise.all([
      collectRendererSourceFiles(rendererRoot),
      readRendererFile('app/AppShell.css'),
    ])
    const combinedSource = (await Promise.all(sourceFiles.map(file => readFile(file, 'utf8')))).join('\n')
    const dynamicPrefixes = new Set(
      [...combinedSource.matchAll(/([a-zA-Z][\w-]*--)\$\{/gu)]
        .flatMap(match => match[1] ? [match[1]] : []),
    )
    const externalPrefixes = ['maplibregl-', 'react-flow__', 'contains-task-list', 'task-list-item']
    const selectorClasses = new Set(
      [...appShellCss.matchAll(/\.([_a-zA-Z][\w-]*)/gu)]
        .flatMap(match => match[1] ? [match[1]] : []),
    )
    const unreachable = [...selectorClasses]
      .filter(className =>
        !combinedSource.includes(className)
        && ![...dynamicPrefixes].some(prefix => className.startsWith(prefix))
        && !externalPrefixes.some(prefix => className.startsWith(prefix)))
      .sort((left, right) => left.localeCompare(right))

    expect(unreachable).toEqual([])
  })

  it('keeps fullscreen chrome on one viewport grid', async () => {
    const [desktopSource, glassSource, entrySource, setupSource] = await Promise.all([
      readRendererFile('app/styles/desktop.css'),
      readRendererFile('app/styles/glass.css'),
      readRendererFile('main.tsx'),
      readRendererFile('app/styles/product-setup.css'),
    ])
    const titlebarRule = desktopSource.match(/\.gf-titlebar-region \.workbench-chrome\s*\{(?<body>[^}]+)\}/u)?.groups?.body ?? ''

    expect(titlebarRule).toContain('width: 100%')
    expect(titlebarRule).toContain('max-width: none')
    expect(titlebarRule).toContain('margin: 0')
    expect(titlebarRule).toContain('var(--ui-titlebar-start-safe')
    expect(titlebarRule).toContain('var(--ui-titlebar-end-safe')
    expect(desktopSource).not.toContain('--gf-window-controls-reserve')
    expect(glassSource).toContain(":root[data-desktop-platform='darwin']")
    expect(glassSource).toContain('--ui-titlebar-start-safe: 78px')
    expect(glassSource).toContain('--ui-titlebar-end-safe: 8px')
    expect(entrySource).toContain('document.documentElement.dataset.desktopPlatform = window.platformDesktop.platform')
    expect(setupSource).toContain('var(--ui-titlebar-start-safe')
    expect(setupSource).toContain('var(--ui-titlebar-end-safe')
    expect(desktopSource).toContain('.gf-panel-separator::before')
    expect(desktopSource).toContain('cursor: col-resize')
  })

  it('keeps active overlays on the same surface contract', async () => {
    const [dialogSource, composerSource, jumpRailSource] = await Promise.all([
      readRendererFile('shared/components/GlassDialog.tsx'),
      readRendererFile('features/conversation/Composer.tsx'),
      readRendererFile('features/conversation/ConversationJumpRail.tsx'),
    ])

    expect(dialogSource).toContain('className="ui-dialog-surface alert"')
    expect(dialogSource).toContain('data-ui-surface="glass"')
    for (const popoverSource of [composerSource, jumpRailSource]) {
      expect(popoverSource).toContain('className="ui-popover-surface')
      expect(popoverSource).toContain('data-ui-surface="glass"')
      expect(popoverSource).not.toContain('className="glass-panel"')
    }
  })
})

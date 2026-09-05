// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 桌面工作台验收
//
//   文件:       desktop.electron.spec.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import {
  PLATFORM_DESKTOP_PROTOCOL_SCHEME,
  PRODUCT_CODENAME,
} from '@geo-agent-platform/shared-types/product-identity'
import type { ChildProcess } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

// Playwright 的 TypeScript loader 会按仓库 package 类型决定 CJS/ESM；
// 测试入口固定从仓库根运行，避免用 import.meta 迫使两种模块语义混用。
const repositoryRoot = path.resolve(process.cwd())
const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop')
const e2eRoot = path.join(repositoryRoot, 'output', 'playwright', 'electron-runtime')
const userDataDirectory = path.join(e2eRoot, 'user-data')
const scale150UserDataDirectory = path.join(e2eRoot, 'user-data-scale-150')
const realBackend = process.env.GEO_AGENT_PLATFORM_E2E_REAL === '1'
const runtimeRoot = realBackend
  ? path.resolve(process.env.RUNTIME_ROOT ?? path.join(repositoryRoot, 'runtime'))
  : path.join(e2eRoot, 'runtime')

let electronApp: ElectronApplication
let workspace: Page
const rendererErrors: string[] = []
const trackedPages = new WeakSet<Page>()
let rendererErrorCursor = 0

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await rm(e2eRoot, { recursive: true, force: true })
  await mkdir(userDataDirectory, { recursive: true })
  if (!realBackend) await mkdir(runtimeRoot, { recursive: true })
  const launched = await launchDesktopApplication(userDataDirectory)
  electronApp = launched.application
  workspace = launched.workspace
})

test.afterEach(() => {
  const newErrors = rendererErrors.slice(rendererErrorCursor)
  rendererErrorCursor = rendererErrors.length
  expect(newErrors).toEqual([])
})

test.afterAll(async () => {
  if (electronApp) await closeElectronApplication(electronApp)
})

test('renders the complete GIS shell even when native services are unavailable', async ({}, testInfo) => {
  await expect(workspace).toHaveURL(new RegExp(
    `^${PLATFORM_DESKTOP_PROTOCOL_SCHEME}://app/index\\.html(?:[?#].*)?$`,
    'u',
  ))
  await expect(workspace.getByRole(
    'region',
    { name: `${PRODUCT_CODENAME} 功能区` },
  )).toBeVisible()
  await expect(workspace.getByRole('complementary', { name: '内容' })).toBeVisible()
  await expect(workspace.getByRole('region', { name: '空间地图' })).toBeVisible()
  await expect(workspace.getByRole('complementary', { name: '智能对话' })).toBeVisible()
  await expect(workspace.locator('footer[aria-label="地图状态"]')).toBeVisible()
  await expect(workspace.getByText(PRODUCT_CODENAME, { exact: true }).first()).toBeVisible()
  await expect(workspace.getByText(`登录 ${PRODUCT_CODENAME}`)).toHaveCount(0)
  await expect(workspace.getByRole(
    'dialog',
    { name: `登录 ${PRODUCT_CODENAME}` },
  )).toHaveCount(0)
  await expect(workspace.locator('.gf-login-overlay')).toHaveCount(0)
  await expect(workspace.getByLabel('邮箱')).toHaveCount(0)
  await expect(workspace.getByLabel('密码')).toHaveCount(0)
  await expect(workspace.getByRole('status', { name: '身份状态：未验证' })).toBeVisible()
  await expect(workspace.getByRole('button', { name: /账号菜单/u })).toHaveCount(0)

  if (!realBackend) {
    await expect(workspace.getByText(/当前处于离线工作台|正在检查本机服务|正在后台启动服务/u))
      .toBeVisible()
    await expect(workspace.getByRole('button', { name: '系统日志' })).toBeVisible()
  }
  await setWindowSize(electronApp, workspace, 1_366, 768)
  await expectMapRuntimeReady(workspace)
  await expect(workspace.getByRole('region', { name: '空间地图' })).toHaveScreenshot(
    'map-workbench-1366x768.png',
    {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    },
  )
  await workspace.screenshot({
    path: testInfo.outputPath('geo-agent-platform-offline-auto-auth.png'),
    animations: 'disabled',
  })
})

test('supports Ribbon commands and both dock-panel collapse cycles', async () => {
  const mapRibbonTab = workspace.getByRole('tab', { name: '地图', exact: true })
  await mapRibbonTab.click()
  await expect(mapRibbonTab).toHaveAttribute('aria-selected', 'true')

  const assistant = workspace.getByRole('complementary', { name: '智能对话' })
  const assistantSeparator = workspace.getByRole('separator', { name: '调整智能对话面板宽度' })
  const separatorBox = await assistantSeparator.boundingBox()
  const assistantWidthBeforePointer = await elementWidth(assistant)
  expect(separatorBox).not.toBeNull()
  if (separatorBox) {
    await workspace.mouse.move(separatorBox.x + separatorBox.width / 2, separatorBox.y + separatorBox.height / 2)
    await workspace.mouse.down()
    await workspace.mouse.move(
      separatorBox.x - 64,
      separatorBox.y + separatorBox.height / 2,
      { steps: 8 },
    )
    await workspace.mouse.up()
  }
  await expect.poll(() => elementWidth(assistant)).not.toBe(assistantWidthBeforePointer)

  await assistantSeparator.focus()
  await expect(assistantSeparator).toBeFocused()
  const assistantWidthBeforeKeyboard = await elementWidth(assistant)
  await workspace.keyboard.press('ArrowRight')
  await expect.poll(() => elementWidth(assistant)).not.toBe(assistantWidthBeforeKeyboard)

  await workspace.getByRole('button', { name: '收起内容面板' }).click()
  await expect(workspace.locator('aside[aria-label="内容"]')).not.toBeVisible()
  await workspace.getByRole('button', { name: '显示内容面板' }).click()
  await expect(workspace.getByRole('complementary', { name: '内容' })).toBeVisible()

  await workspace.getByRole('button', { name: '收起智能对话面板' }).click()
  await expect(workspace.locator('aside[aria-label="智能对话"]')).not.toBeVisible()
  await workspace.getByRole('button', { name: '显示智能对话面板' }).click()
  await expect(workspace.getByRole('complementary', { name: '智能对话' })).toBeVisible()

  await workspace.keyboard.press('Alt+Q')
  const commandSearch = workspace.getByRole('textbox', { name: '命令搜索' })
  await expect(commandSearch).toBeFocused()
  await commandSearch.fill('图层')
  await workspace.keyboard.press('Enter')
  await expect(workspace.getByRole('complementary', { name: '内容' })).toBeVisible()
  await workspace.keyboard.press('Escape')
})

test('opens service and model settings without requiring an account', async ({}, testInfo) => {
  const manageRibbonTab = workspace.getByRole('tab', { name: '管理', exact: true })
  await manageRibbonTab.click()
  await expect(manageRibbonTab).toHaveAttribute('aria-selected', 'true')

  await workspace.getByRole('button', { name: '服务与模型' }).click()
  await expect(workspace.getByRole('heading', { name: '服务与模型', level: 1 })).toBeVisible()
  await expect(workspace.getByRole('heading', { name: '模型服务与运行路由' })).toBeVisible()
  await expect(workspace.getByRole('heading', { name: '选择具体模型' })).toBeVisible()
  await expect(workspace.getByRole('heading', { name: '天地图' })).toBeVisible()
  await expect(workspace.getByRole('tab', { name: '服务与模型', exact: true })).toBeVisible()

  await workspace.screenshot({
    path: testInfo.outputPath('model-routing-settings.png'),
    animations: 'disabled',
  })

  const mapRibbonTab = workspace.getByRole('tab', { name: '地图', exact: true })
  await mapRibbonTab.click()
  await workspace.getByRole('button', { name: '地图浏览' }).click()
  await expect(workspace.getByRole('region', { name: '空间地图' })).toBeVisible()
})

test('traps system-log focus and restores it after keyboard dismissal', async () => {
  test.skip(realBackend, '系统日志入口只在本机后台不可用时常驻显示。')

  const openLogs = workspace.getByRole('button', { name: '系统日志' })
  await openLogs.focus()
  await expect(openLogs).toBeFocused()
  await openLogs.click()

  const dialog = workspace.getByRole('dialog', { name: '系统日志' })
  await expect(dialog).toBeVisible()
  const search = dialog.getByRole('textbox', { name: '搜索' })
  await expect(search).toBeFocused()

  const tabbableControls = dialog.locator([
    'button:visible:not([disabled])',
    'input:visible:not([disabled])',
    'select:visible:not([disabled])',
    '[href]:visible',
    '[tabindex]:visible:not([tabindex="-1"])',
  ].join(', '))
  await tabbableControls.last().focus()
  await workspace.keyboard.press('Tab')
  await expect(tabbableControls.first()).toBeFocused()

  await workspace.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(openLogs).toBeFocused()
})

test('deduplicates one workspace and opens a separate window for another workspace', async () => {
  await invokeWindowCommand(workspace, {
    action: 'bind-workspace',
    workspace: workspaceDescriptor('workspace-e2e-a', '验收工作区 A'),
  })
  await expect.poll(() => electronApp.windows().length).toBe(1)

  await minimizeWindow(electronApp, workspace)
  await expect.poll(() => windowState(electronApp, workspace)).toMatchObject({
    minimized: true,
  })
  await invokeWindowCommand(workspace, {
    action: 'open-workspace',
    workspace: workspaceDescriptor('workspace-e2e-a', '验收工作区 A'),
  })
  await expect.poll(() => electronApp.windows().length).toBe(1)
  await expect.poll(() => windowState(electronApp, workspace)).toMatchObject({
    minimized: false,
    visible: true,
  })

  await invokeWindowCommand(workspace, {
    action: 'open-workspace',
    workspace: workspaceDescriptor('workspace-e2e-b', '验收工作区 B'),
  })
  await expect.poll(() => electronApp.windows().length).toBe(2)
  const second = electronApp.windows().find(page => page !== workspace)
  expect(second).toBeDefined()
  if (!second) throw new Error('第二个工作区窗口未创建。')
  await second.waitForLoadState('domcontentloaded')
  const secondWindow = await electronApp.browserWindow(second)
  await expect.poll(() => secondWindow.evaluate(window => window.getTitle()))
    .toContain(`验收工作区 B — ${PRODUCT_CODENAME}`)
  await second.close()
  await expect.poll(() => electronApp.windows().length).toBe(1)
})

test('fits the complete workbench at the supported minimum window size', async ({}, testInfo) => {
  await setWindowSize(electronApp, workspace, 1_024, 768)
  await workspace.waitForTimeout(300)
  await expectWorkbenchFitsViewport(workspace)
  await expectBackendNoticeAvoidsPrimaryControls(workspace)

  await workspace.screenshot({
    path: testInfo.outputPath('geo-agent-platform-1024x768.png'),
    animations: 'disabled',
  })
})

test('captures every supported desktop size without clipping workbench regions', async ({}, testInfo) => {
  const sizes = [
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_366, height: 768, label: '1366x768' },
  ] as const

  for (const size of sizes) {
    await setWindowSize(electronApp, workspace, size.width, size.height)
    await workspace.waitForTimeout(300)
    await expectMapRuntimeReady(workspace)
    await expectWorkbenchFitsViewport(workspace)
    await expectBackendNoticeAvoidsPrimaryControls(workspace)
    await workspace.screenshot({
      path: testInfo.outputPath(`geo-agent-platform-${size.label}-100.png`),
      animations: 'disabled',
    })
  }
})

test('runs a real auto-authenticated conversation when native services are enabled', async () => {
  test.setTimeout(180_000)
  test.skip(!realBackend, '设置 GEO_AGENT_PLATFORM_E2E_REAL=1 后运行原生 PostgreSQL/PostGIS、Worker 与 API 全链路。')

  const composer = workspace.getByRole('textbox', { name: '输入空间分析需求' })
  await expect(composer).toBeVisible()
  await expect(composer).toBeEnabled()
  const assistantAnswers = workspace.locator(
    '.cc-timeline-item--answer .cc-assistant-copy:not(.cc-assistant-copy--thought)',
  )
  const answerCountBefore = await assistantAnswers.count()
  const question = `Electron 验收：杭州今天会下雨吗？ ${Date.now()}`
  await composer.fill(question)
  await composer.press('Enter')
  await expect(composer).toHaveValue('')
  await expect(workspace.getByRole('article', { name: '用户消息' }).filter({ hasText: question }))
    .toBeVisible()
  await expect.poll(() => assistantAnswers.count(), { timeout: 75_000 })
    .toBeGreaterThan(answerCountBefore)
  await expect(assistantAnswers.last()).toContainText(/\S/u, { timeout: 15_000 })
  await expect(
    workspace.locator('.cc-title-block small').filter({ hasText: '已完成' }),
  ).toBeVisible({ timeout: 90_000 })
})

test('uploads an NC folder and completes a natural-language nowcast workflow', async ({}, testInfo) => {
  test.setTimeout(360_000)
  test.skip(!realBackend, '设置 GEO_AGENT_PLATFORM_E2E_REAL=1 后运行原生 PostgreSQL/PostGIS、Worker 与 API 全链路。')
  const ncFolder = process.env.GEO_AGENT_PLATFORM_E2E_NC_FOLDER
  test.skip(!ncFolder, '设置 GEO_AGENT_PLATFORM_E2E_NC_FOLDER 后运行真实 NC 文件夹上传与短临分析。')

  await electronApp.evaluate(({ dialog }, selectedFolder) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({
        canceled: false,
        filePaths: [selectedFolder],
      }),
    })
  }, ncFolder)

  const uploadFolder = workspace.getByRole('button', { name: '上传文件夹' })
  await expect(uploadFolder).toBeVisible()
  await expect(uploadFolder).toBeEnabled()
  await uploadFolder.click()

  const uploadStatus = workspace
    .getByRole('status')
    .filter({ hasText: /4\/4 个文件/u })
  await expect(uploadStatus).toBeVisible({ timeout: 60_000 })
  const uploadSummary = await uploadStatus.innerText()
  if (uploadSummary.includes('失败')) {
    const visibleErrors = await workspace.getByRole('alert').allInnerTexts()
    throw new Error(
      `NC 文件夹上传失败：${uploadSummary}；${visibleErrors.join('；') || '界面没有提供失败详情。'}`,
    )
  }

  const composer = workspace.getByRole('textbox', { name: '输入空间分析需求' })
  const assistantAnswers = workspace.locator(
    '.cc-timeline-item--answer .cc-assistant-copy:not(.cc-assistant-copy--thought)',
  )
  const answerCountBefore = await assistantAnswers.count()
  const question = '我刚上传了一个 NC 文件夹。请只看这批文件，告诉我杭州接下来三小时的雨是变大还是变小，并整理成表格；不要查询其他天气来源。'
  await composer.fill(question)
  await composer.press('Enter')

  await expect(composer).toHaveValue('')
  await expect(workspace.getByRole('article', { name: '用户消息' }).filter({ hasText: question }))
    .toBeVisible()
  await expect.poll(
    () => workspace.locator('.cc-timeline-item--tool').count(),
    { timeout: 90_000 },
  ).toBeGreaterThan(0)
  const terminalStatus = await waitForRunTerminalStatus(workspace, 240_000, {
    workflowApprovalScreenshotPath: testInfo.outputPath(
      'geo-agent-platform-nowcast-workflow-approval.png',
    ),
  })
  if (terminalStatus.includes('失败')) {
    const visibleErrors = await workspace.getByRole('alert').allInnerTexts()
    throw new Error(`NC 短临分析失败：${visibleErrors.join('；') || '请查看运行记录。'}`)
  }
  await expect.poll(() => assistantAnswers.count())
    .toBeGreaterThan(answerCountBefore)

  const finalAnswer = assistantAnswers.last()
  await expect(finalAnswer).toContainText(/降水|雨量|毫米|mm/iu)
  await expect(
    workspace
      .locator('.cc-timeline-item--tool')
      .filter({ hasText: /自动化流程|气象文件|短临|降水/iu })
      .first(),
  ).toBeVisible()
  await workspace.screenshot({
    path: testInfo.outputPath('geo-agent-platform-nowcast-natural-language.png'),
    animations: 'disabled',
  })
})

test('fits the workbench and initializes MapLibre at 150% display scale', async ({}, testInfo) => {
  await closeElectronApplication(electronApp)
  await mkdir(scale150UserDataDirectory, { recursive: true })
  const launched = await launchDesktopApplication(
    scale150UserDataDirectory,
    ['--force-device-scale-factor=1.5'],
  )
  electronApp = launched.application
  workspace = launched.workspace

  await setWindowSize(electronApp, workspace, 1_366, 768)
  await workspace.waitForTimeout(300)
  await expect.poll(() => workspace.evaluate(() => window.devicePixelRatio))
    .toBeCloseTo(1.5, 1)
  await expectMapRuntimeReady(workspace)
  await expectWorkbenchFitsViewport(workspace)
  await expectBackendNoticeAvoidsPrimaryControls(workspace)
  await workspace.screenshot({
    path: testInfo.outputPath('geo-agent-platform-1366x768-scale-150.png'),
    animations: 'disabled',
  })
})

async function waitForRunTerminalStatus(
  page: Page,
  timeoutMs: number,
  options: {
    workflowApprovalScreenshotPath?: string
  } = {},
): Promise<string> {
  const terminal = page
    .locator('.cc-title-block small')
    .filter({ hasText: /已完成|失败/u })
    .first()
  const workflowApproval = page.getByRole('dialog', {
    name: '批准这个智能体工作流？',
  })
  const deadline = Date.now() + timeoutMs
  let capturedApproval = false

  while (Date.now() < deadline) {
    if (await terminal.isVisible()) return terminal.innerText()

    if (await workflowApproval.isVisible()) {
      if (!capturedApproval && options.workflowApprovalScreenshotPath) {
        await page.screenshot({
          path: options.workflowApprovalScreenshotPath,
          animations: 'disabled',
        })
        capturedApproval = true
      }
      const submit = workflowApproval.getByRole('button', { name: '提交审批' })
      await expect(submit).toBeEnabled()
      await submit.click()
      await expect(workflowApproval).not.toBeVisible({ timeout: 30_000 })
      continue
    }

    await page.waitForTimeout(500)
  }

  const visibleStatuses = await page
    .locator('.cc-title-block small')
    .allInnerTexts()
  throw new Error(
    `运行没有在 ${timeoutMs}ms 内结束；当前状态：${visibleStatuses.join('、') || '未知'}`,
  )
}

function desktopEnvironment(): NodeJS.ProcessEnv {
  const apiBaseUrl = realBackend
    ? process.env.APP_BASE_URL ?? 'http://127.0.0.1:8000'
    : 'http://127.0.0.1:65530'
  return {
    ...process.env,
    NODE_ENV: 'development',
    APP_ENV: 'development',
    GEO_AGENT_PLATFORM_ROOT: repositoryRoot,
    RUNTIME_ROOT: runtimeRoot,
    APP_BASE_URL: apiBaseUrl,
    API_PORT: new URL(apiBaseUrl).port || '8000',
    // 离线壳验收不启动数据库 Broker；真实后端验收覆盖本机托管身份。
    GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH: realBackend ? 'true' : 'false',
    BOOTSTRAP_ADMIN_EMAIL:
      process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'geo-agent-platform-e2e@example.com',
    BETTER_AUTH_ALLOW_SIGN_UP: process.env.BETTER_AUTH_ALLOW_SIGN_UP ?? 'true',
  }
}

async function launchDesktopApplication(
  userDataPath: string,
  extraArguments: string[] = [],
): Promise<{ application: ElectronApplication; workspace: Page }> {
  const application = await electron.launch({
    executablePath: resolveElectronExecutable(),
    cwd: desktopRoot,
    args: [
      `--user-data-dir=${userDataPath}`,
      ...extraArguments,
      desktopRoot,
    ],
    env: desktopEnvironment(),
    timeout: 60_000,
  })
  application.on('window', page => {
    trackUnexpectedRendererErrors(page, rendererErrors)
  })
  const firstWorkspace = await application.firstWindow()
  trackUnexpectedRendererErrors(firstWorkspace, rendererErrors)
  await firstWorkspace.waitForLoadState('domcontentloaded')
  return { application, workspace: firstWorkspace }
}

function resolveElectronExecutable(): string {
  const configured = process.env.PLAYWRIGHT_ELECTRON_EXECUTABLE
  if (configured) return path.resolve(configured)
  if (process.platform === 'win32') {
    return path.join(repositoryRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  }
  if (process.platform === 'darwin') {
    return path.join(
      repositoryRoot,
      'node_modules',
      'electron',
      'dist',
      'Electron.app',
      'Contents',
      'MacOS',
      'Electron',
    )
  }
  return path.join(repositoryRoot, 'node_modules', 'electron', 'dist', 'electron')
}

function workspaceDescriptor(workspaceId: string, workspaceName: string) {
  return { workspaceId, workspaceName, sessionId: null, threadId: null }
}

async function invokeWindowCommand(
  page: Page,
  command: {
    action: 'open-workspace' | 'bind-workspace'
    workspace: ReturnType<typeof workspaceDescriptor>
  },
): Promise<void> {
  await page.evaluate(async input => {
    const bridge = (window as typeof window & {
      platformDesktop?: {
        window: { command(value: unknown): Promise<void> }
      }
    }).platformDesktop
    if (!bridge) throw new Error('Electron Preload 桥未加载。')
    await bridge.window.command(input)
  }, command)
}

async function setWindowSize(
  application: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  const nativeWindow = await application.browserWindow(page)
  await nativeWindow.evaluate((window, size) => {
    window.setSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))).toEqual({ width, height })
}

async function expectBackendNoticeAvoidsPrimaryControls(page: Page): Promise<void> {
  const notice = page.locator('.desktop-backend-notice')
  if (await notice.count() === 0 || !await notice.isVisible()) return
  const noticeBox = await notice.boundingBox()
  expect(noticeBox).not.toBeNull()
  if (!noticeBox) return

  for (const protectedControl of [
    page.locator('.maplibregl-ctrl-attrib').first(),
    page.locator('.cc-composer').first(),
  ]) {
    if (await protectedControl.count() === 0 || !await protectedControl.isVisible()) continue
    const controlBox = await protectedControl.boundingBox()
    expect(controlBox).not.toBeNull()
    if (controlBox) expect(rectanglesOverlap(noticeBox, controlBox)).toBe(false)
  }
}

function rectanglesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
}

async function minimizeWindow(
  application: ElectronApplication,
  page: Page,
): Promise<void> {
  const nativeWindow = await application.browserWindow(page)
  await nativeWindow.evaluate(window => {
    window.minimize()
  })
}

async function closeElectronApplication(application: ElectronApplication): Promise<void> {
  const child = application.process()
  if (child.exitCode !== null || child.signalCode !== null) return

  const exitRequest = application.evaluate(({ app }) => {
    // Playwright 自身持有 Electron 的 Node inspector/CDP 连接；验收结束使用
    // Electron 的强制测试退出，避免等待这些测试连接反过来阻塞 app.quit()。
    app.exit(0)
  }).catch(() => undefined)
  await Promise.race([
    exitRequest,
    new Promise(resolve => setTimeout(resolve, 2_000)),
  ])
  if (await waitForProcessExit(child, 10_000)) return

  child.kill()
  await waitForProcessExit(child, 5_000)
}

async function waitForProcessExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (process.exitCode !== null || process.signalCode !== null) return true
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      process.off('exit', handleExit)
      resolve(false)
    }, timeoutMs)
    const handleExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    process.once('exit', handleExit)
  })
}

async function windowState(
  application: ElectronApplication,
  page: Page,
): Promise<{
  minimized: boolean
  visible: boolean
}> {
  const nativeWindow = await application.browserWindow(page)
  return nativeWindow.evaluate(window => {
    return {
      minimized: window.isMinimized(),
      visible: window.isVisible(),
    }
  })
}

async function elementWidth(locator: ReturnType<Page['locator']>): Promise<number> {
  return locator.evaluate(element => element.getBoundingClientRect().width)
}

async function expectMapRuntimeReady(page: Page): Promise<void> {
  await expect(page.getByText('正在初始化地图…')).toHaveCount(0, { timeout: 15_000 })
  const mapRegion = page.getByRole('region', { name: '地图画布' })
  const mapCanvas = mapRegion.locator('canvas.maplibregl-canvas')
  await expect(mapRegion).toBeVisible()
  await expect(mapRegion.getByText('地图无法渲染')).toHaveCount(0)
  await expect(mapRegion).toHaveAttribute('data-map-ready', 'true', { timeout: 15_000 })
  await expect(mapCanvas).toBeVisible({ timeout: 15_000 })
  await expect(mapRegion.locator('.dc-map-stage__controls')).toHaveCount(0)
  const canvasSize = await mapCanvas.evaluate(canvas => ({
    width: canvas.getBoundingClientRect().width,
    height: canvas.getBoundingClientRect().height,
  }))
  expect(canvasSize.width).toBeGreaterThan(200)
  expect(canvasSize.height).toBeGreaterThan(200)

  await expect.poll(() => {
    const workerUrls = page.workers().map(worker => worker.url())
    return workerUrls.some(url =>
      new RegExp(
        `^${PLATFORM_DESKTOP_PROTOCOL_SCHEME}`
          + '://app/assets/maplibre-gl-worker-[^/]+\\.js(?:[?#].*)?$',
        'u',
      ).test(url),
    )
  }, { timeout: 15_000 }).toBe(true)
}

async function expectWorkbenchFitsViewport(page: Page): Promise<void> {
  await expect.poll(async () => {
    const fit = await page.evaluate((productCodename) => {
      const required = [
        document.querySelector(`[aria-label="${productCodename} 功能区"]`),
        document.querySelector('[aria-label="内容"]'),
        document.querySelector('[aria-label="空间地图"]'),
        document.querySelector('[aria-label="智能对话"]'),
        document.querySelector('footer[aria-label="地图状态"]'),
      ]
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const regions = required.map(element => {
        const rect = element?.getBoundingClientRect()
        const visible = Boolean(rect && rect.width > 0 && rect.height > 0)
        const inside = Boolean(
          rect
          && rect.left >= -1
          && rect.top >= -1
          && rect.right <= viewport.width + 1
          && rect.bottom <= viewport.height + 1,
        )
        return { visible, inside }
      })
      return {
        overflowXOk:
          document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1,
        overflowYOk:
          document.documentElement.scrollHeight - document.documentElement.clientHeight <= 1,
        visibleRegions: regions.filter(region => region.visible).length,
        insideRegions: regions.filter(region => region.inside).length,
      }
    }, PRODUCT_CODENAME)
    return fit
  }, { timeout: 15_000 }).toEqual({
    overflowXOk: true,
    overflowYOk: true,
    visibleRegions: 5,
    insideRegions: 5,
  })
}

function trackUnexpectedRendererErrors(page: Page, errors: string[]): void {
  if (trackedPages.has(page)) return
  trackedPages.add(page)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (/ERR_CONNECTION_REFUSED|Failed to fetch/iu.test(text)) return
    const location = message.location()
    errors.push(location.url ? `${text} (${location.url})` : text)
  })
}

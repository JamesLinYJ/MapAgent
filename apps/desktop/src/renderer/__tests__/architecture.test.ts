// +-------------------------------------------------------------------------
//
//   地理智能平台 - 前端架构守卫测试
//
//   文件:       architecture.test.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('frontend architecture guards', () => {
  it('keeps unchecked indexed access enabled for production and test code', async () => {
    const tsconfig = JSON.parse(await readFile(path.resolve(process.cwd(), 'tsconfig.renderer.json'), 'utf8')) as {
      compilerOptions?: { noUncheckedIndexedAccess?: boolean }
    }
    expect(tsconfig.compilerOptions?.noUncheckedIndexedAccess).toBe(true)
  })

  it('keeps HTTP and WebSocket ownership outside the sandboxed Renderer', async () => {
    const rendererRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const files = (await collectSourceFiles(rendererRoot))
      .filter(file => !file.endsWith(path.join('__tests__', 'architecture.test.ts')))
    const sources = await Promise.all(files.map(async file => ({
      file,
      source: await readFile(file, 'utf8'),
    })))

    for (const { file, source } of sources) {
      expect(source.includes('new WebSocket('), file).toBe(false)
      expect(source.includes("from 'partysocket/ws'"), file).toBe(false)
      expect(source.includes('net.fetch('), file).toBe(false)
      expect(source.includes('navigator.clipboard'), file).toBe(false)
      expect(source.includes('window.confirm('), file).toBe(false)
      expect(source.includes('window.alert('), file).toBe(false)
      expect(source.includes('window.prompt('), file).toBe(false)
    }

    const controlGateway = await readFile(
      path.resolve(process.cwd(), 'src', 'main', 'controlGateway.ts'),
      'utf8',
    )
    const apiGateway = await readFile(
      path.resolve(process.cwd(), 'src', 'main', 'apiGateway.ts'),
      'utf8',
    )
    expect(controlGateway.includes("import WebSocket from 'ws'")).toBe(true)
    expect(controlGateway.includes('new WebSocket(')).toBe(true)
    expect(controlGateway.includes('parseWsControlRequest({')).toBe(true)
    expect(controlGateway.includes('wsServerMessageSchema.parse(')).toBe(true)
    expect(controlGateway.includes('wsCommandContract(command).response.parse(')).toBe(true)
    expect(controlGateway.includes('const serverMessageSchema =')).toBe(false)
    expect(controlGateway.includes('const responsePayloadSchema =')).toBe(false)
    expect(apiGateway.includes('net.fetch(')).toBe(true)
  })

  it('keeps one physical desktop event reader in the Renderer composition root', async () => {
    const rendererRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const files = (await collectSourceFiles(rendererRoot))
      .filter(file => !file.includes(`${path.sep}__tests__${path.sep}`))
      .filter(file => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
    const directReaders: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      if (/\.events\.subscribe\s*\(/u.test(source)) directReaders.push(path.relative(rendererRoot, file))
    }

    expect(directReaders).toEqual([])
    const routerSource = await readFile(
      path.join(rendererRoot, 'app/events/DesktopEventRouter.ts'),
      'utf8',
    )
    const providerSource = await readFile(
      path.join(rendererRoot, 'app/events/DesktopEventRouterProvider.tsx'),
      'utf8',
    )
    const runtimeSource = await readFile(
      path.join(rendererRoot, 'app/DesktopApplicationRuntime.tsx'),
      'utf8',
    )
    expect(routerSource).toContain('this.options.source.subscribe(')
    expect(providerSource).toContain('router.start()')
    expect(providerSource).toContain('return () => router.stop()')
    expect(runtimeSource).toContain('<DesktopEventRouterProvider>')
  })

  it('keeps mutable conversation indexes outside React render', async () => {
    const rendererRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const timelineProjection = await readFile(
      path.join(rendererRoot, 'features/runs/useConversationTimelineProjection.ts'),
      'utf8',
    )
    const presentationProjection = await readFile(
      path.join(rendererRoot, 'features/conversation/useConversation.ts'),
      'utf8',
    )
    const runProjection = await readFile(
      path.join(rendererRoot, 'features/runs/useRunState.ts'),
      'utf8',
    )

    for (const source of [timelineProjection, presentationProjection]) {
      expect(source).toContain('useLayoutEffect(() => {')
      expect(source).toContain('useSyncExternalStore(')
      expect(source).not.toContain('useMemo(')
    }
    expect(runProjection).toContain('if (immediate) dispatch(action)')
    expect(runProjection).toContain('else startTransition(() => dispatch(action))')
  })

  it('keeps local paths and DOM files behind the Main-owned native picker', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src')
    const rendererRoot = path.join(srcRoot, 'renderer')
    const files = (await collectSourceFiles(rendererRoot))
      .filter(file => !file.includes(`${path.sep}__tests__${path.sep}`))

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      expect(source.includes('type="file"'), file).toBe(false)
      expect(source.includes('instanceof File'), file).toBe(false)
      expect(source.includes('webkitRelativePath'), file).toBe(false)
      expect(/\bFile\[\]/u.test(source), file).toBe(false)
      expect(/:\s*File(?:\s*[),;=]|\s*$)/mu.test(source), file).toBe(false)
    }

    const productEntries = [
      'features/conversation/Composer.tsx',
      'features/layers/LayerManagerViews.tsx',
      'features/debug/DebugPage.tsx',
      'features/tools/automationStudio/AutomationStudio.tsx',
      'features/artifacts/DetailSourcesPanel.tsx',
    ]
    for (const relativePath of productEntries) {
      const source = await readFile(path.join(rendererRoot, relativePath), 'utf8')
      expect(source.includes('/api/desktopFiles'), relativePath).toBe(true)
    }

    const preloadSource = await readFile(path.join(srcRoot, 'preload/index.ts'), 'utf8')
    const bridgeSource = await readFile(path.join(srcRoot, 'contracts/desktopBridge.ts'), 'utf8')
    const registrySource = await readFile(path.join(srcRoot, 'main/fileHandleRegistry.ts'), 'utf8')
    expect(preloadSource.includes('webUtils')).toBe(false)
    expect(preloadSource.includes('getPathForFile')).toBe(false)
    expect(preloadSource.includes('fileRegister')).toBe(false)
    expect(bridgeSource.includes('register(files')).toBe(false)
    expect(registrySource.includes('dialog.showOpenDialog')).toBe(true)
    expect(registrySource.includes('prepareFolderFiles')).toBe(true)
  })

  it('keeps workspace navigation facts in the Zustand workspace store', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const navigationSource = await readFile(path.join(srcRoot, 'app/controllers/navigationController.ts'), 'utf8')
    const storeSource = await readFile(path.join(srcRoot, 'app/stores/workspaceStore.ts'), 'utf8')

    expect(storeSource.includes("from 'zustand'")).toBe(true)
    for (const field of ['activeNav', 'panelMode', 'activeSidebarItem', 'workspaceMode']) {
      expect(storeSource.includes(field), field).toBe(true)
    }

    expect(navigationSource.includes('useWorkspaceStore')).toBe(true)
    expect(navigationSource.includes("useState<PrimaryNav>")).toBe(false)
    expect(navigationSource.includes("useState<PanelMode>")).toBe(false)
    expect(navigationSource.includes("useState<SidebarItemId>")).toBe(false)
    expect(navigationSource.includes("useState<WorkspaceMode>")).toBe(false)
  })

  it('keeps model connection facts in the Zustand model connection store', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const controllerSource = await readFile(path.join(srcRoot, 'app/controllers/connectionController.ts'), 'utf8')
    const storeSource = await readFile(path.join(srcRoot, 'app/stores/modelConnectionStore.ts'), 'utf8')

    expect(storeSource.includes("from 'zustand'")).toBe(true)
    for (const field of ['providers', 'provider', 'model', 'applyProviders', 'changeProvider']) {
      expect(storeSource.includes(field), field).toBe(true)
    }

    expect(controllerSource.includes('useModelConnectionStore')).toBe(true)
    expect(controllerSource.includes('useState(')).toBe(false)
    expect(controllerSource.includes('startTransition')).toBe(false)
  })

  it('separates artifact, basemap, and upload facts into domain stores', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const controllerSource = await readFile(path.join(srcRoot, 'app/controllers/workspaceResourceComposition.ts'), 'utf8')
    const artifactStoreSource = await readFile(path.join(srcRoot, 'app/stores/artifactStore.ts'), 'utf8')
    const basemapStoreSource = await readFile(path.join(srcRoot, 'app/stores/basemapStore.ts'), 'utf8')
    const uploadStoreSource = await readFile(path.join(srcRoot, 'app/stores/uploadStore.ts'), 'utf8')
    const artifactSource = await readFile(
      path.join(srcRoot, 'app/controllers/resources/useArtifactResources.ts'),
      'utf8',
    )
    const basemapSource = await readFile(
      path.join(srcRoot, 'app/controllers/resources/useBasemapResources.ts'),
      'utf8',
    )
    const uploadSource = await readFile(
      path.join(srcRoot, 'app/controllers/resources/useUploadResources.ts'),
      'utf8',
    )

    expect(artifactStoreSource.includes("from 'zustand'")).toBe(true)
    expect(artifactStoreSource.includes('selectedArtifactId')).toBe(true)
    expect(artifactStoreSource.includes('hydrationErrors')).toBe(true)
    expect(artifactStoreSource.includes('basemaps')).toBe(false)
    expect(artifactStoreSource.includes('isFileSubmitting')).toBe(false)
    expect(basemapStoreSource.includes('basemaps')).toBe(true)
    expect(basemapStoreSource.includes('selectedBasemapKey')).toBe(true)
    expect(basemapStoreSource.includes('selectedArtifactId')).toBe(false)
    expect(uploadStoreSource.includes('uploadedLayerName')).toBe(true)
    expect(uploadStoreSource.includes('isFileSubmitting')).toBe(true)
    expect(uploadStoreSource.includes('selectedBasemapKey')).toBe(false)

    expect(controllerSource.includes('useResourceStore')).toBe(false)
    expect(artifactSource.includes('useArtifactStore')).toBe(true)
    expect(basemapSource.includes('useBasemapStore')).toBe(true)
    expect(uploadSource.includes('useUploadStore')).toBe(true)
    for (const token of [
      'useState<BasemapDescriptor',
      "useState('osm')",
      'useState<Record<string, GeoJSON.FeatureCollection>>',
      'useState<Record<string, Record<string, unknown>>>',
      'useState<string>()',
      'useState<UploadReference[]>',
      'useState<FileEntry[]>',
      'useState(false)',
    ]) {
      expect(controllerSource.includes(token), token).toBe(false)
    }
  })

  it('keeps session, thread, history cursor, and canonical transcript in one Zustand store', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const controllerSource = await readFile(path.join(srcRoot, 'app/controllers/sessionThreadController.ts'), 'utf8')
    const storeSource = await readFile(path.join(srcRoot, 'app/stores/sessionStore.ts'), 'utf8')

    expect(storeSource.includes("from 'zustand'")).toBe(true)
    for (const field of [
      'sessionRuns',
      'sessionThreads',
      'threadRuns',
      'activeThreadId',
      'runHistoryCursor',
      'isRunHistoryLoading',
      'canonicalThreadItems',
    ]) {
      expect(storeSource.includes(field), field).toBe(true)
    }
    expect(controllerSource.includes('useSessionStore')).toBe(true)
    expect(controllerSource.includes('runHistoryCursorRef')).toBe(false)
    expect(controllerSource.includes('runHistoryLoadingRef')).toBe(false)
    expect(appShellSource.includes('useState<ConversationItem[]>')).toBe(false)
  })

  it('keeps the public API client as a resource-owned facade with schema-validated modules', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const apiRoot = path.join(srcRoot, 'api')
    const clientSource = await readFile(path.join(apiRoot, 'client.ts'), 'utf8')
    const moduleNames = [
      'authApi',
      'conversationApi',
      'memoryApi',
      'resourceApi',
      'runApi',
      'toolApi',
      'automationApi',
    ]

    expect(clientSource.includes('requestControl(')).toBe(false)
    expect(clientSource.includes('requestJson(')).toBe(false)
    expect(clientSource.includes('requestFormJson(')).toBe(false)
    for (const moduleName of moduleNames) {
      expect(clientSource.includes(`export * from './${moduleName}'`), moduleName).toBe(true)
      const source = await readFile(path.join(apiRoot, `${moduleName}.ts`), 'utf8')
      expect(source.includes("from './client'"), moduleName).toBe(false)
    }
    const conversationSource = await readFile(path.join(apiRoot, 'conversationApi.ts'), 'utf8')
    const runSource = await readFile(path.join(apiRoot, 'runApi.ts'), 'utf8')
    expect(conversationSource.includes('desktopWorkspaceBootstrapSnapshotSchema')).toBe(true)
    expect(conversationSource.includes("requestControl('thread:get'")).toBe(true)
    expect(runSource.includes("requestControl('run:start'")).toBe(true)
    expect(runSource.includes("requestControl('run:subscribe'")).toBe(true)
  })

  it('keeps layer facts in Zustand and layer mutations in an application module', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const controllerSource = await readFile(path.join(srcRoot, 'app/controllers/workspaceResourceComposition.ts'), 'utf8')
    const storeSource = await readFile(path.join(srcRoot, 'app/stores/layerStore.ts'), 'utf8')
    const layerResourcesSource = await readFile(
      path.join(srcRoot, 'app/controllers/resources/useManagedLayerResources.ts'),
      'utf8',
    )

    expect(storeSource.includes("from 'zustand'")).toBe(true)
    expect(storeSource.includes('layers')).toBe(true)
    for (const token of [
      'listLayers(',
      'deleteLayer(',
      'importManagedLayer(',
      'replaceManagedLayer(',
      'updateLayer(',
    ]) {
      expect(storeSource.includes(token), token).toBe(false)
      expect(layerResourcesSource.includes(token), token).toBe(true)
    }

    expect(layerResourcesSource.includes('useLayerStore')).toBe(true)
    expect(controllerSource.includes('useManagedLayerResources')).toBe(true)
    expect(controllerSource.includes('useLayerStore')).toBe(false)
    expect(controllerSource.includes('useState<LayerDescriptor')).toBe(false)
  })

  it('keeps the resource controller as a composition facade', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const controllerSource = await readFile(path.join(srcRoot, 'app/controllers/workspaceResourceComposition.ts'), 'utf8')

    for (const moduleName of [
      'useArtifactResources',
      'useBasemapResources',
      'useManagedLayerResources',
      'useMapResources',
      'useUploadResources',
    ]) {
      expect(controllerSource.includes(moduleName), moduleName).toBe(true)
    }
    expect(controllerSource.includes("from '../../api/client'")).toBe(false)
    expect(controllerSource.includes('useEffect(')).toBe(false)
    expect(controllerSource.includes('useResourceStore')).toBe(false)
  })

  it('keeps map rendering isolated from AppShell', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const workspaceShellSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceShell.tsx'), 'utf8')
    const mapPanelSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceMapPanel.tsx'), 'utf8')
    const mapPreloadSource = await readFile(path.join(srcRoot, 'app/layout/workspaceMapPreload.ts'), 'utf8')
    const mapActivationSource = await readFile(path.join(srcRoot, 'app/layout/useWorkspaceMapActivation.ts'), 'utf8')

    expect(appShellSource.includes('WorkspaceShell')).toBe(true)
    expect(workspaceShellSource.includes('WorkspaceMapPanel')).toBe(true)
    expect(appShellSource.includes('useWorkspaceMapActivation')).toBe(true)
    expect(appShellSource.includes('../features/map/MapCanvas')).toBe(false)
    expect(appShellSource.includes('../features/map/MapErrorBoundary')).toBe(false)
    expect(appShellSource.includes('requestIdleCallback')).toBe(false)
    expect(mapPanelSource.includes("import('../../features/map/MapCanvas')")).toBe(false)
    expect(mapPanelSource.includes('loadWorkspaceMapCanvas')).toBe(true)
    expect(mapPreloadSource.includes("import('../../features/map/MapCanvas')")).toBe(true)
    expect(mapPanelSource.includes('MapErrorBoundary')).toBe(true)
    expect(mapActivationSource.includes('requestIdleCallback')).toBe(true)
    expect(mapActivationSource.includes('requestMapFocus')).toBe(true)
  })

  it('extends map sources and styles through renderer registries', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const layerSyncSource = await readFile(path.join(srcRoot, 'features/map/MapCanvasLayerSync.ts'), 'utf8')
    const registrySource = await readFile(
      path.join(srcRoot, 'features/map/renderers/MapLayerRendererRegistry.ts'),
      'utf8',
    )
    const defaultRegistrySource = await readFile(
      path.join(srcRoot, 'features/map/renderers/defaultRendererRegistry.ts'),
      'utf8',
    )

    expect(layerSyncSource.includes('defaultRendererRegistry')).toBe(true)
    expect(layerSyncSource.includes("source.kind ===")).toBe(false)
    expect(layerSyncSource.includes("style.kind ===")).toBe(false)
    expect(registrySource.includes('未注册地图数据源渲染器')).toBe(true)
    expect(registrySource.includes('未注册地图样式渲染器')).toBe(true)
    expect(defaultRegistrySource.includes('defaultSourceRenderers')).toBe(true)
    expect(defaultRegistrySource.includes('defaultStyleRenderers')).toBe(true)
  })

  it('keeps thread lifecycle and map scene commands behind explicit application ports', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const activeThreadSource = await readFile(path.join(srcRoot, 'app/services/activeThreadOrchestrator.ts'), 'utf8')
    const mapCommandsSource = await readFile(path.join(srcRoot, 'features/map/MapSceneCommandService.ts'), 'utf8')
    const layerManagerSource = await readFile(path.join(srcRoot, 'features/layers/useLayerManager.ts'), 'utf8')

    expect(activeThreadSource.includes("from 'react'")).toBe(false)
    expect(activeThreadSource.includes('useSessionStore')).toBe(false)
    expect(activeThreadSource.includes('syncLocation')).toBe(true)
    expect(mapCommandsSource.includes("from 'react'")).toBe(false)
    expect(mapCommandsSource.includes('MapSceneCommandPort')).toBe(true)
    expect(mapCommandsSource.includes('MapSceneMutationCoordinator')).toBe(true)
    expect(layerManagerSource.includes('onAddLayer')).toBe(true)
    expect(layerManagerSource.includes("title: '地图浏览'")).toBe(false)
  })

  it('keeps tool management rendering isolated from AppShell', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const workspaceShellSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceShell.tsx'), 'utf8')
    const toolPanelSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceToolPanel.tsx'), 'utf8')

    expect(appShellSource.includes('WorkspaceShell')).toBe(true)
    expect(workspaceShellSource.includes('WorkspaceToolPanel')).toBe(true)
    expect(appShellSource.includes('../features/tools/ToolManagementPage')).toBe(false)
    expect(toolPanelSource.includes("import('../../features/tools/ToolManagementPage')")).toBe(true)
    expect(toolPanelSource.includes('ToolManagementPageProps')).toBe(true)
  })

  it('keeps inspector rendering isolated from AppShell', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const workspaceShellSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceShell.tsx'), 'utf8')
    const inspectorSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceInspectorPanel.tsx'), 'utf8')
    const detailSource = await readFile(path.join(srcRoot, 'features/artifacts/DetailPanel.tsx'), 'utf8')

    expect(appShellSource.includes('WorkspaceShell')).toBe(true)
    expect(workspaceShellSource.includes('WorkspaceInspectorPanel')).toBe(true)
    expect(appShellSource.includes('../features/artifacts/DetailPanel')).toBe(false)
    expect(appShellSource.includes('WorkbenchProgressCard')).toBe(false)
    expect(inspectorSource.includes("import('../../features/artifacts/DetailPanel')")).toBe(true)
    expect(inspectorSource.includes('WorkbenchProgressCard')).toBe(true)
    expect(inspectorSource.includes('extends DetailPanelProps')).toBe(false)
    expect(inspectorSource.includes('detail: WorkspaceInspectorDetail')).toBe(true)
    for (const modeProps of [
      'SummaryDetailPanelProps',
      'LayerOverviewDetailPanelProps',
      'HistoryDetailPanelProps',
      'ComputeDetailPanelProps',
      'SourcesDetailPanelProps',
      'ExportDetailPanelProps',
      'ConfigDetailPanelProps',
      'LayerManagerDetailPanelProps',
    ]) {
      expect(detailSource.includes(modeProps), modeProps).toBe(true)
    }
    expect(detailSource.includes('void uploadedLayerName')).toBe(false)
    expect(detailSource.includes('void selectedBasemapName')).toBe(false)
    expect(detailSource.includes('void isFileSubmitting')).toBe(false)
  })

  it('keeps platform side effects in feature-scoped coordinators', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const controllerRoot = path.join(srcRoot, 'app/controllers')
    const coordinatorFiles = [
      'useDesktopWindowCoordinator.ts',
      'useWorkspaceAuthenticationCoordinator.ts',
      'useRunHistoryLoader.ts',
      'useWorkspaceResourceLoader.ts',
      'useWorkspaceExportCoordinator.ts',
      'toolingController.ts',
    ]

    expect(appShellSource.includes('useEffect(')).toBe(false)
    expect(appShellSource.includes('useState(')).toBe(false)
    expect(appShellSource.includes('window.platformDesktop')).toBe(false)
    expect(appShellSource.includes('exportWorkspaceResult')).toBe(false)
    expect(appShellSource.includes('requestDesktopDownload')).toBe(false)
    for (const file of coordinatorFiles) {
      const source = await readFile(path.join(controllerRoot, file), 'utf8')
      expect(source.length, file).toBeGreaterThan(0)
      expect(appShellSource.includes(file.replace(/\.ts$/, '')), file).toBe(true)
    }
  })

  it('keeps conversation rendering isolated from AppShell', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const workspaceShellSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceShell.tsx'), 'utf8')
    const conversationPanelSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceConversationPanel.tsx'), 'utf8')

    expect(appShellSource.includes('WorkspaceShell')).toBe(true)
    expect(workspaceShellSource.includes('WorkspaceConversationPanel')).toBe(true)
    expect(appShellSource.includes('../features/conversation/ChatPanel')).toBe(false)
    expect(conversationPanelSource.includes("from '../../features/conversation/ChatPanel'")).toBe(true)
    expect(conversationPanelSource.includes('ChatPanelProps')).toBe(true)
  })

  it('keeps third-party product identity and internal automation wording out of rendered pages', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const pageFiles = (await collectSourceFiles(srcRoot))
      .filter(file => file.endsWith('.tsx'))
      .filter(file => !file.includes(`${path.sep}__tests__${path.sep}`))
    const forbiddenVisibleText = [
      'ArcGIS Pro',
      'Automation Studio',
      '未命名 Automation',
      '目标 Automation',
      '启动 Automation',
      'Automation JSON',
      '内置 Automation',
      'Automation 运行',
    ]

    for (const file of pageFiles) {
      const source = await readFile(file, 'utf8')
      for (const text of forbiddenVisibleText) {
        expect(source.includes(text), `${file}: ${text}`).toBe(false)
      }
    }
  })

  it('keeps memory management out of the conversation timeline', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const timelineSource = await readFile(path.join(srcRoot, 'features/conversation/ConversationTimeline.tsx'), 'utf8')
    const conversationTypes = await readFile(path.join(srcRoot, 'features/conversation/types.ts'), 'utf8')
    const memoryManagement = await readFile(path.join(srcRoot, 'features/tools/SdkExtensionManagement.tsx'), 'utf8')

    expect(timelineSource.includes('MemoryPanel')).toBe(false)
    expect(timelineSource.includes('cc-memory-panel')).toBe(false)
    expect(conversationTypes.includes('memories?:')).toBe(false)
    expect(memoryManagement.includes("from '../memory/types'")).toBe(true)
    expect(memoryManagement.includes('cc-memory-item__type')).toBe(false)
    expect(memoryManagement.includes('sdk-memory-card__type')).toBe(true)
  })

  it('keeps debug page rendering isolated from AppShell', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const routeHostSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceRouteHost.tsx'), 'utf8')
    const debugPanelSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceDebugPanel.tsx'), 'utf8')

    expect(appShellSource.includes('WorkspaceRouteHost')).toBe(true)
    expect(routeHostSource.includes('WorkspaceDebugPanel')).toBe(true)
    expect(appShellSource.includes("../features/debug/DebugPage")).toBe(false)
    expect(debugPanelSource.includes("import('../../features/debug/DebugPage')")).toBe(true)
    expect(debugPanelSource.includes('DebugPageProps')).toBe(true)
  })

  it('keeps desktop document assembly out of AppShell', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const appShellSource = await readFile(path.join(srcRoot, 'app/AppShell.tsx'), 'utf8')
    const routeHostSource = await readFile(path.join(srcRoot, 'app/layout/WorkspaceRouteHost.tsx'), 'utf8')

    expect(appShellSource.includes('WorkspaceRouteHost')).toBe(true)
    expect(appShellSource.includes('AppRoutes')).toBe(false)
    expect(appShellSource.includes('SecurityAdminPage')).toBe(false)
    expect(appShellSource.includes("import { WorkspaceLayout")).toBe(false)
    expect(routeHostSource.includes('WorkspaceLayout')).toBe(true)
    expect(routeHostSource.includes('SecurityAdminPage')).toBe(true)
    expect(routeHostSource.includes('renderWorkspace')).toBe(true)
  })

  it('keeps Renderer diagnostics behind the shared client diagnostics boundary', async () => {
    const srcRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const files = (await collectSourceFiles(srcRoot))
      .filter(file => !file.endsWith(path.join('__tests__', 'architecture.test.ts')))
    const diagnosticsPath = path.join(srcRoot, 'shared/utils/clientDiagnostics.ts')

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      if (file === diagnosticsPath) {
        expect(source.includes('console.warn')).toBe(true)
        expect(source.includes('console.error')).toBe(true)
        expect(source.includes('sanitizeClientDiagnostic')).toBe(true)
        continue
      }
      expect(source.includes('console.warn'), file).toBe(false)
      expect(source.includes('console.error'), file).toBe(false)
    }
  })

  it('keeps session and CSRF credentials outside Renderer source', async () => {
    const rendererRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const files = (await collectSourceFiles(rendererRoot))
      .filter(file => !file.includes(`${path.sep}__tests__${path.sep}`))
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      expect(source.includes('csrfToken'), file).toBe(false)
      expect(source.includes('x-geo-agent-platform-csrf'), file).toBe(false)
      expect(source.includes("type { AuthMe"), file).toBe(false)
    }

    const authGateway = await readFile(
      path.resolve(process.cwd(), 'src', 'main', 'authGateway.ts'),
      'utf8',
    )
    expect(authGateway.includes('desktopAuthProjectionSchema.parse')).toBe(true)
    expect(authGateway.includes('csrfToken: auth.csrfToken')).toBe(true)
  })
})

async function collectSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue
      files.push(...await collectSourceFiles(fullPath))
    } else if (/\.(ts|tsx)$/u.test(entry.name)) {
      files.push(fullPath)
    }
  }
  return files
}

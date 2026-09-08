// +-------------------------------------------------------------------------
//
//   地理智能平台 - 平台架构守卫测试
//
//   文件:       architecture.test.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-27):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 核心应用统一归入 apps，共享契约源码统一归入 src，
//           并增加旧目录与过时事实源不得回流的结构守卫。
//
//   维护记录 (2026-07-27):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 增加 Web Chat 与本机 Agent CLI 共用只读对话展示投影的结构守卫。
//
//   维护记录 (2026-07-29):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 增加浏览器工作台、匿名分享和容器地图旁车不得回流的守卫，
//           并固定退役分享 URL 的 HTTP 404 行为。
// --------------------------------------------------------------------------

import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { describe, expect, it } from 'vitest'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'
import { platformNotFoundHandler } from './app/httpNotFound.js'
import type { ToolDef } from './framework/types.js'
import type { ConversationItem } from './schemas/types.js'
import { PlatformPersistenceFacade } from './store/platformPersistenceFacade.js'
import { PersistenceFacadeTestHarness } from '../test-support/persistenceFacadeHarness.js'
import { AutomationCompiler } from './automations/automationCompiler.js'
import { automationDefinitionSchema } from './automations/schemas.js'

describe('platform architecture', () => {
  it('keeps the tracked core monorepo classified under canonical directories', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..', '..')
    const rootPackage = JSON.parse(
      await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { workspaces?: string[] }

    expect(rootPackage.workspaces).toContain('apps/server')
    expect(rootPackage.workspaces).toContain('apps/desktop')
    expect(rootPackage.workspaces).toContain('packages/db')
    expect(rootPackage.workspaces).toContain('packages/conversation-presentation')
    expect(rootPackage.workspaces).not.toContain('server')

    for (const application of ['server', 'desktop', 'worker']) {
      await expect(stat(path.join(repositoryRoot, 'apps', application))).resolves.toBeDefined()
    }
    await expect(stat(path.join(repositoryRoot, 'server'))).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(stat(path.join(repositoryRoot, 'packages/shared-types/src'))).resolves.toBeDefined()
    await expect(stat(path.join(repositoryRoot, 'packages/shared-types/src/contracts.test.ts'))).resolves.toBeDefined()
    await expect(stat(path.join(repositoryRoot, 'packages/db/src/schema.ts'))).resolves.toBeDefined()
    await expect(stat(path.join(repositoryRoot, 'packages/db/src/connection.ts'))).resolves.toBeDefined()
    await expect(stat(path.join(repositoryRoot, 'packages/db/src/connection.test.ts'))).resolves.toBeDefined()
    await expect(stat(path.join(repositoryRoot, 'packages/conversation-presentation/src'))).resolves.toBeDefined()
    await expect(stat(path.join(repositoryRoot, 'packages/shared-types/src-ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })

    const documentationCategories = (await readdir(path.join(repositoryRoot, 'docs'), {
      withFileTypes: true,
    }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    // 只守卫长期文档事实源；一次性汇报材料不存在时不保留空目录。
    for (const category of ['architecture', 'operations', 'standards']) {
      expect(documentationCategories).toContain(category)
    }

    const architectureOverview = await readFile(
      path.join(repositoryRoot, 'docs/architecture/overview.md'),
      'utf8',
    )
    expect(architectureOverview).toContain('PostgreSQL/PostGIS')
    expect(architectureOverview).toContain('内容寻址对象存储')
    expect(architectureOverview).toContain('db/')
    expect(architectureOverview).not.toContain('runtime/conversations/`：按 session')
  })

  it('keeps shared protocol schemas modular and server parsing on the shared contract', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..', '..')
    const sharedRoot = path.join(repositoryRoot, 'packages/shared-types/src')
    const serverEntry = await readFile(path.join(process.cwd(), 'src/schemas/types.ts'), 'utf8')
    const sharedEntry = await readFile(path.join(sharedRoot, 'index.ts'), 'utf8')
    const serverTsconfig = JSON.parse(await readFile(path.join(process.cwd(), 'tsconfig.json'), 'utf8')) as {
      compilerOptions?: { noUncheckedIndexedAccess?: boolean }
    }

    for (const domain of ['core', 'conversation', 'runtime', 'platform', 'resources', 'transport', 'worker']) {
      await expect(stat(path.join(sharedRoot, `${domain}.ts`))).resolves.toBeDefined()
      expect(sharedEntry.includes(`export * from './${domain}.js'`), domain).toBe(true)
    }
    expect(serverEntry.trimEnd().endsWith("export * from '@geo-agent-platform/shared-types'")).toBe(true)
    expect(serverEntry.includes("from 'zod'")).toBe(false)
    expect(serverTsconfig.compilerOptions?.noUncheckedIndexedAccess).toBe(true)
  })

  it('keeps the tool runtime split into plan, fact, workflow and projection owners', async () => {
    const sourceRoot = path.join(process.cwd(), 'src')
    const toolsRoot = path.join(sourceRoot, 'agent-runtime/tools')
    const coordinatorSource = await readFile(
      path.join(sourceRoot, 'agent/toolExecutionCoordinator.ts'),
      'utf8',
    )

    for (const owner of [
      'ToolCatalog',
      'ToolPlanCompiler',
      'ToolRouter',
      'ToolPolicy',
      'ToolExecutionGate',
      'ToolInvocationLedger',
      'ToolEffectCommitter',
      'WorkflowBinder',
      'ToolProjectionPublisher',
    ]) {
      await expect(stat(path.join(toolsRoot, `${owner}.ts`))).resolves.toBeDefined()
    }
    for (const retired of [
      'agent-runtime/step/AgentToolPlan.ts',
      'agent/runToolConcurrencyGate.ts',
      'agent/toolCallRecoveryLedger.ts',
      'agent/toolExecutionPolicy.ts',
    ]) {
      await expect(stat(path.join(sourceRoot, retired))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(coordinatorSource).toContain('new WorkflowBinder')
    expect(coordinatorSource).toContain('new ToolProjectionPublisher')
    for (const retiredResponsibility of [
      'startAgentWorkflowStep',
      'completeAgentWorkflowStep',
      'failAgentWorkflowStep',
      'appendToolResult(',
      'appendToolFailure(',
      'claimedWorkflowSteps =',
      'outputMetadata =',
    ]) {
      expect(coordinatorSource.includes(retiredResponsibility), retiredResponsibility).toBe(false)
    }
  })

  it('keeps the Drizzle schema and fresh database baseline aligned on ownership foreign keys', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..', '..')
    const schemaSource = await readFile(path.join(repositoryRoot, 'packages/db/src/schema.ts'), 'utf8')
    const serverSchemaBridge = await readFile(path.join(process.cwd(), 'src/db/schema.ts'), 'utf8')
    const baselineSource = await readFile(
      path.join(repositoryRoot, 'infra/database/schema.sql'),
      'utf8',
    )
    const securityDatabaseSource = await readFile(
      path.join(process.cwd(), 'src/security/database.ts'),
      'utf8',
    )

    const drizzleForeignKeys = [
      "references(() => authUser.id, { onDelete: 'cascade' })",
      "references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' })",
      "references(() => platformUsers.userId, { onDelete: 'restrict' })",
      "references(() => platformUsers.userId, { onDelete: 'set null' })",
      "references(() => platformSessions.sessionId, { onDelete: 'cascade' })",
      "references(() => platformThreads.threadId, { onDelete: 'set null' })",
      "references(() => platformConversationEntries.entryId, { onDelete: 'set null' })",
      "references(() => platformConversationEntries.entryId, { onDelete: 'cascade' })",
      "references(() => platformMeteorologicalDatasets.datasetId, { onDelete: 'cascade' })",
      "references(() => platformRuns.runId, { onDelete: 'set null' })",
    ]
    const baselineForeignKeys = [
      'FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE',
      'FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE RESTRICT',
      'FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE',
      'FOREIGN KEY (actor_user_id) REFERENCES public.platform_users(user_id) ON DELETE SET NULL',
      'FOREIGN KEY (session_id) REFERENCES public.platform_sessions(session_id) ON DELETE CASCADE',
      'FOREIGN KEY (thread_id) REFERENCES public.platform_threads(thread_id) ON DELETE SET NULL',
      'FOREIGN KEY (based_on_entry_id) REFERENCES public.platform_conversation_entries(entry_id) ON DELETE SET NULL',
      'FOREIGN KEY (boundary_entry_id) REFERENCES public.platform_conversation_entries(entry_id) ON DELETE CASCADE',
      'FOREIGN KEY (dataset_id) REFERENCES public.platform_meteorological_datasets(dataset_id) ON DELETE CASCADE',
      'FOREIGN KEY (last_run_id) REFERENCES public.platform_runs(run_id) ON DELETE SET NULL',
      'FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE SET NULL',
    ]

    for (const foreignKey of drizzleForeignKeys) {
      expect(schemaSource.includes(foreignKey), foreignKey).toBe(true)
    }
    for (const foreignKey of baselineForeignKeys) {
      expect(baselineSource.includes(foreignKey), foreignKey).toBe(true)
    }
    expect(serverSchemaBridge).toContain("export * from '@geo-agent-platform/db/schema'")
    expect(securityDatabaseSource).not.toMatch(/db\.execute\(sql`\s*(?:CREATE|ALTER|DROP)\b/iu)
  })

  it('keeps removed response/message-frame models out of runtime source', async () => {
    const root = path.resolve(process.cwd(), '..', '..')
    const files = await collectSourceFiles([
      path.join(root, 'apps/server/src'),
      path.join(root, 'apps/desktop/src'),
      path.join(root, 'packages/shared-types/src'),
    ])
    const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')

    const forbidden = [
      'final' + 'Response',
      'Agent' + 'FinalResponse',
      'agent' + 'FinalResponse',
      'message' + '_fra' + 'me',
      'Agent' + 'MessageFrame',
      'append' + '_message' + '_fra' + 'me',
      'subscribe' + '_messages',
      'list' + '_messages',
      'as ' + 'any',
    ]

    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps production source independent of the local checkout path', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..', '..')
    const files = await collectProductionFiles([
      path.join(repositoryRoot, 'AGENTS.md'),
      path.join(repositoryRoot, 'apps/server/src'),
      path.join(repositoryRoot, 'apps/desktop/src'),
      path.join(repositoryRoot, 'apps/worker/src'),
      path.join(repositoryRoot, 'packages/shared-types/src'),
      path.join(repositoryRoot, 'packages/gis-meteorology/src/gis_meteorology'),
    ])
    const windowsAbsolutePath = /(^|[^A-Za-z])[A-Za-z]:[\\/]/u
    const localHomeAbsolutePath = /(^|[^A-Za-z])\/(?:Users|home)\/[^/\s"'`]+/u
    const checkoutPathVariants = new Set([
      repositoryRoot,
      repositoryRoot.replace(/\\/gu, '/'),
      path.win32.normalize(repositoryRoot),
    ])

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const checkoutPath of checkoutPathVariants) {
        expect(source.includes(checkoutPath), `${file}: ${checkoutPath}`).toBe(false)
      }
      expect(windowsAbsolutePath.test(source), file).toBe(false)
      expect(localHomeAbsolutePath.test(source), file).toBe(false)
    }
  })

  it('keeps the mutable product codename in its single identity fact source', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..', '..')
    const productIdentityFile = path.join(
      repositoryRoot,
      'packages/shared-types/src/productIdentity.ts',
    )
    const roots = [
      path.join(repositoryRoot, '.env.example'),
      path.join(repositoryRoot, 'AGENTS.md'),
      path.join(repositoryRoot, 'README.md'),
      path.join(repositoryRoot, 'apps'),
      path.join(repositoryRoot, 'deploy'),
      path.join(repositoryRoot, 'dev.ps1'),
      path.join(repositoryRoot, 'dev.sh'),
      path.join(repositoryRoot, 'docs'),
      path.join(repositoryRoot, 'infra'),
      path.join(repositoryRoot, 'package-lock.json'),
      path.join(repositoryRoot, 'package.json'),
      path.join(repositoryRoot, 'packages'),
      path.join(repositoryRoot, 'scripts'),
      path.join(repositoryRoot, 'tests'),
    ]
    const files = await collectRepositoryTextFiles(roots)
    const normalizedCodename = PRODUCT_CODENAME.toLowerCase()
    const offenders = (await Promise.all(files.map(async (file) => {
      if (path.resolve(file) === path.resolve(productIdentityFile)) return null
      const source = await readFile(file, 'utf8')
      if (!source.toLowerCase().includes(normalizedCodename)) return null
      return path.relative(repositoryRoot, file).replace(/\\/gu, '/')
    }))).filter((file): file is string => file !== null)

    expect(offenders).toEqual([])
  })

  it('keeps the Windows development stack bound to loopback explicitly', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..', '..')
    const source = await readFile(path.join(repositoryRoot, 'dev.ps1'), 'utf8')
    const developmentDefaultsSource = await readFile(
      path.join(repositoryRoot, 'packages/operations-supervisor/src/developmentDefaults.ts'),
      'utf8',
    )

    expect(source.includes('@geo-agent-platform/operations-supervisor')).toBe(true)
    expect(source.includes('API_HOST')).toBe(false)
    expect(developmentDefaultsSource.includes("API_HOST: '127.0.0.1'")).toBe(true)
    expect(developmentDefaultsSource.includes('WEB_DEV_HOST')).toBe(false)
  })

  it('keeps the retired browser, public-sharing, and container sidecars out of active runtime boundaries', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..', '..')
    const retiredPaths = [
      path.join(repositoryRoot, 'apps', 'web'),
      path.join(repositoryRoot, 'apps/server/src/webStaticRuntime.ts'),
      path.join(repositoryRoot, 'apps/server/src/routes/share.ts'),
      path.join(repositoryRoot, 'apps/server/src/routes/share.test.ts'),
      path.join(repositoryRoot, 'infra/compose/docker-compose.dev.yml'),
      path.join(repositoryRoot, 'infra/compose/docker-compose.prod.yml'),
      path.join(repositoryRoot, 'infra/docker/web/nginx.conf'),
      path.join(repositoryRoot, 'infra/martin/config.yaml'),
      path.join(repositoryRoot, 'scripts/check-infra.ps1'),
      path.join(repositoryRoot, 'scripts/check-infra.sh'),
      path.join(repositoryRoot, 'scripts/check-infra-production.ps1'),
      path.join(repositoryRoot, 'scripts/check-infra-production.sh'),
      path.join(repositoryRoot, 'scripts/run-infra.ps1'),
      path.join(repositoryRoot, 'scripts/run-infra.sh'),
      path.join(repositoryRoot, 'scripts/run-infra-production.ps1'),
      path.join(repositoryRoot, 'scripts/run-infra-production.sh'),
      path.join(repositoryRoot, 'scripts/stop-infra.ps1'),
      path.join(repositoryRoot, 'scripts/stop-infra.sh'),
      path.join(repositoryRoot, 'scripts/stop-infra-production.ps1'),
      path.join(repositoryRoot, 'scripts/stop-infra-production.sh'),
      path.join(repositoryRoot, 'scripts/check-web-bundle-budget.mjs'),
      path.join(repositoryRoot, 'scripts/replace-isrecord-web.py'),
    ]
    for (const retiredPath of retiredPaths) {
      await expect(stat(retiredPath), retiredPath).rejects.toMatchObject({ code: 'ENOENT' })
    }

    const rootPackage = JSON.parse(
      await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as {
      workspaces?: string[]
      scripts?: Record<string, string>
    }
    expect(rootPackage.workspaces).not.toContain('apps/web')
    for (const [name, command] of Object.entries(rootPackage.scripts ?? {})) {
      expect(name.endsWith(':web'), name).toBe(false)
      expect(command.includes('apps/web'), name).toBe(false)
    }

    const activeSourceFiles = await collectProductionFiles([
      path.join(repositoryRoot, 'apps/server/src'),
      path.join(repositoryRoot, 'apps/desktop/src'),
      path.join(repositoryRoot, 'packages/shared-types/src'),
    ])
    const activeSource = (await Promise.all(
      activeSourceFiles.map(file => readFile(file, 'utf8')),
    )).join('\n')
    const retiredSourceTokens = [
      ['web', 'StaticRuntime'].join(''),
      ['/api', 'share'].join('/'),
      ['share', 'token'].join('_'),
      ['share', 'Token'].join(''),
    ]
    for (const token of retiredSourceTokens) {
      expect(activeSource.includes(token), token).toBe(false)
    }

    const baselineSource = await readFile(
      path.join(repositoryRoot, 'infra/database/schema.sql'),
      'utf8',
    )
    expect(baselineSource.includes(['share', 'token'].join('_'))).toBe(false)
    const databaseSqlFiles = (await readdir(
      path.join(repositoryRoot, 'infra/database'),
    )).filter(file => file.endsWith('.sql')).sort()
    expect(databaseSqlFiles).toEqual(['schema.sql'])
    await expect(stat(path.join(repositoryRoot, 'infra/migrations')))
      .rejects.toMatchObject({ code: 'ENOENT' })

    const operationalSourceFiles = await collectProductionFiles([
      path.join(repositoryRoot, 'packages/operations-supervisor/src'),
      path.join(repositoryRoot, 'apps/server/src/framework'),
      path.join(repositoryRoot, 'apps/server/src/map'),
    ])
    const runtimeEntryFiles: string[] = [
      path.join(repositoryRoot, '.env.example'),
      path.join(repositoryRoot, 'dev.ps1'),
      path.join(repositoryRoot, 'dev.sh'),
    ]
    await collect(path.join(repositoryRoot, 'scripts'), runtimeEntryFiles)
    await collect(path.join(repositoryRoot, 'deploy'), runtimeEntryFiles)
    const runtimeEntryTextFiles = runtimeEntryFiles.filter(file => {
      const normalized = file.replace(/\\/gu, '/')
      if (normalized.includes('/__pycache__/')) return false
      return /\.(?:c?js|example|json|mjs|ps1|py|service|sh|sql|template|ts|xml|ya?ml)$/u.test(file)
    })
    const operationalSource = [
      ...await Promise.all(
        operationalSourceFiles.map(file => readFile(file, 'utf8')),
      ),
      ...await Promise.all(runtimeEntryTextFiles.map(file => readFile(file, 'utf8'))),
    ].join('\n')
    const retiredRuntimePatterns = [
      { name: 'Docker', pattern: /\bdocker\b/iu },
      { name: 'Compose', pattern: /\bcompose\b/iu },
      { name: 'Martin', pattern: /\bmartin\b/iu },
      { name: 'TiTiler', pattern: /\btitiler\b/iu },
      { name: 'PM2', pattern: /\bpm2\b/iu },
      { name: 'process-compose', pattern: /\bprocess-compose\b/iu },
      { name: 'xterm', pattern: /\bxterm\b/iu },
      { name: 'node-pty', pattern: /\bnode-pty\b/iu },
    ]
    for (const retiredRuntime of retiredRuntimePatterns) {
      expect(operationalSource, retiredRuntime.name).not.toMatch(retiredRuntime.pattern)
    }

    const lock = JSON.parse(
      await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
    ) as { packages?: Record<string, { dev?: boolean } | undefined> }
    const installedProductionPackages = Object.entries(lock.packages ?? {})
      .filter(([, packageMetadata]) => packageMetadata?.dev !== true)
      .map(([packagePath]) => packagePath)
    for (const retiredPackage of [
      'node_modules/pm2',
      'node_modules/node-pty',
      'node_modules/@xterm/',
      'node_modules/process-compose',
      'node_modules/docker-compose',
      'node_modules/dockerode',
    ]) {
      expect(
        installedProductionPackages.some(packagePath => (
          packagePath === retiredPackage
          || packagePath.startsWith(retiredPackage.endsWith('/') ? retiredPackage : `${retiredPackage}/`)
        )),
        retiredPackage,
      ).toBe(false)
    }
  })

  it('keeps retired public share URLs on the stable server 404 boundary', async () => {
    const mainSource = await readFile(path.join(process.cwd(), 'src/main.ts'), 'utf8')
    const app = new Hono()
    app.all('/api/share', platformNotFoundHandler)
    app.all('/api/share/*', platformNotFoundHandler)
    app.use('*', cors())
    app.notFound(platformNotFoundHandler)

    expect(mainSource).toContain('app.notFound(platformNotFoundHandler)')
    expect(mainSource.indexOf('app.all(`${retiredPublicShareRoot}/*`'))
      .toBeLessThan(mainSource.indexOf("app.use('*', cors("))
    const requests = [
      { method: 'GET', path: '/api/share/retired-token' },
      { method: 'GET', path: '/api/share/retired-token/history?before=entry_1' },
      { method: 'POST', path: '/api/share/retired-token' },
      { method: 'HEAD', path: '/api/share/retired-token' },
      { method: 'OPTIONS', path: '/api/share/retired-token' },
    ]
    for (const request of requests) {
      const response = await app.request(request.path, { method: request.method })
      expect(response.status, `${request.method} ${request.path}`).toBe(404)
      if (request.method !== 'HEAD') {
        await expect(response.json()).resolves.toEqual({ detail: 'Not found' })
      }
    }
  })

  it('keeps remote browser terminal dependencies and runtimes removed', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..', '..')
    const lockSource = await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8')
    const devEntry = await readFile(path.join(repositoryRoot, 'dev.ps1'), 'utf8')

    for (const dependency of ['"node-pty"', '"@xterm/xterm"', '"@xterm/headless"', '"pm2"']) {
      expect(lockSource.includes(dependency), dependency).toBe(false)
    }
    for (const runtimeName of ['OpsGateway', 'TerminalBroker']) {
      expect(devEntry.includes(runtimeName), runtimeName).toBe(false)
    }
    expect(devEntry.includes('@geo-agent-platform/operations-supervisor')).toBe(true)
    expect(devEntry.includes('process-compose')).toBe(false)
    await expect(stat(path.join(repositoryRoot, 'apps/operations'))).rejects.toThrow()
  })

  it('keeps the local Agent CLI classified and on the canonical API runtime boundary', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..', '..')
    const agentRoot = path.join(repositoryRoot, 'apps/operations-console/src/agent')
    const categories = (await readdir(agentRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    const productionFiles = await collectProductionFiles([agentRoot])
    const sourceEntries = await Promise.all(productionFiles.map(async file => ({
      file,
      source: await readFile(file, 'utf8'),
    })))
    const sessionSource = await readFile(
      path.join(agentRoot, 'application/localAgentSession.ts'),
      'utf8',
    )
    const entrySource = await readFile(
      path.join(agentRoot, 'cli/localAgentConsoleEntry.ts'),
      'utf8',
    )
    const websocketSource = await readFile(
      path.join(repositoryRoot, 'apps/server/src/ws/handler.ts'),
      'utf8',
    )
    const supervisorFiles = await collectProductionFiles([
      path.join(repositoryRoot, 'packages/operations-supervisor/src'),
    ])

    expect(categories).toEqual(['application', 'cli', 'transport', 'ui'])
    expect(sessionSource.includes("client.send('run:start'")).toBe(true)
    expect(sessionSource.includes("send('run:respond-decision'")).toBe(true)
    expect(entrySource.includes("LocalOperationsBrokerClient.open(projectRoot, 'agent')")).toBe(true)
    expect(entrySource.includes('apps/server/src')).toBe(false)
    expect(entrySource.includes('../../../server')).toBe(false)
    expect(websocketSource.includes('authenticateLocalAgentHeaders')).toBe(true)
    expect(websocketSource.includes('isLoopbackAddress')).toBe(true)
    for (const { file, source } of sourceEntries) {
      expect(source.includes("from '@openai/agents'"), file).toBe(false)
      expect(source.includes('createAppContainer'), file).toBe(false)
      expect(source.includes('fakeAuth'), file).toBe(false)
    }
    for (const file of supervisorFiles) {
      expect((await readFile(file, 'utf8')).includes('operations/agent'), file).toBe(false)
    }
  })

  it('keeps Desktop Chat and the local Agent CLI on one read-only conversation projection', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..', '..')
    const presentationRoot = path.join(repositoryRoot, 'packages/conversation-presentation')
    const presentationSource = await readFile(
      path.join(presentationRoot, 'src/presentation.ts'),
      'utf8',
    )
    const consoleViewSource = await readFile(
      path.join(repositoryRoot, 'apps/operations-console/src/agent/ui/localAgentView.ts'),
      'utf8',
    )
    const desktopConversationSource = await readFile(
      path.join(repositoryRoot, 'apps/desktop/src/renderer/features/conversation/useConversation.ts'),
      'utf8',
    )
    const devLauncherSource = await readFile(
      path.join(repositoryRoot, 'packages/operations-supervisor/src/devLauncher.ts'),
      'utf8',
    )

    expect(presentationSource.includes('deriveEntriesFromItems')).toBe(true)
    expect(presentationSource.includes('displayIdentifier')).toBe(true)
    expect(presentationSource.includes("from 'react'")).toBe(false)
    expect(presentationSource.includes("from 'ink'")).toBe(false)
    expect(consoleViewSource.includes("from '@geo-agent-platform/conversation-presentation'")).toBe(true)
    expect(desktopConversationSource.includes("from '@geo-agent-platform/conversation-presentation'")).toBe(true)
    expect(devLauncherSource.includes("'@geo-agent-platform/conversation-presentation'")).toBe(true)
    for (const packageName of ['shared-types', 'conversation-presentation', 'operations-supervisor']) {
      const packageJson = JSON.parse(await readFile(
        path.join(repositoryRoot, 'packages', packageName, 'package.json'),
        'utf8',
      )) as { scripts?: Record<string, string> }
      expect(packageJson.scripts?.['build:dev']).toBeTruthy()
      expect(packageJson.scripts?.['build:dev']?.includes('rmSync')).toBe(false)
    }
    await expect(stat(path.join(
      repositoryRoot,
      'apps/desktop/src/renderer/features/conversation/items.ts',
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps PlatformPersistenceFacade as a conversation and artifact composition facade', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/store/platformPersistenceFacade.ts'), 'utf8')
    const requiredDelegates = [
      'new SessionStore',
      'new ThreadStore',
      'new RunStore',
      'new ArtifactStore',
      'new ContentObjectGateway',
      'new ArtifactPublicationRepository',
      'new MeteorologicalStore',
      'new RuntimeConfigStore',
      'new ToolCatalogStore',
    ]
    const forbiddenWritePaths = [
      'db.execute',
      'sql`',
      'platform_',
      'payloadStore.saveSession',
      'payloadStore.createThread',
      'payloadStore.saveThread',
      'payloadStore.moveThreadToTrash',
      'payloadStore.createRun',
      'payloadStore.saveRun',
      'payloadStore.appendEvent',
      'payloadStore.appendItem',
      'payloadStore.appendTranscript',
      'payloadStore.saveMemory',
      'payloadStore.appendCompaction',
      'payloadStore.appendArtifact',
      'payloadStore.putObject',
      'payloadStore.readObject',
      'payloadStore.appendValue',
      'payloadStore.appendAgentTranscript',
      'payloadStore.saveAgentsSdkCheckpointEnvelope',
      'payloadStore.readAgentsSdkCheckpointEnvelope',
    ]

    for (const delegate of requiredDelegates) {
      expect(source.includes(delegate), delegate).toBe(true)
    }
    expect(source).toMatch(/private readonly payloadStore: ConversationPayloadStore/u)
    expect(source).not.toMatch(/^\s*readonly payloadStore: ConversationPayloadStore/mu)
    for (const forbidden of forbiddenWritePaths) {
      expect(source.includes(forbidden), forbidden).toBe(false)
    }
  })

  it('injects domain persistence ports and the event hub independently', async () => {
    const root = process.cwd()
    const facadeSource = await readFile(path.join(root, 'src/store/platformPersistenceFacade.ts'), 'utf8')
    const containerSource = await readFile(path.join(root, 'src/app/container.ts'), 'utf8')
    const runtimePortSource = await readFile(path.join(root, 'src/store/runtimePorts.ts'), 'utf8')
    const coreServiceFiles = [
      'src/automations/automationDefinitionService.ts',
      'src/automations/automationRunner.ts',
      'src/automations/scheduledTaskService.ts',
      'src/usage/usageStatsService.ts',
      'src/agent/runtime.ts',
      'src/tools/persistentToolExecutor.ts',
    ]

    expect(facadeSource.includes('readonly events')).toBe(false)
    expect(facadeSource.includes('events?: PlatformEventHub')).toBe(true)
    expect(containerSource.includes('const events = new PlatformEventHub()')).toBe(true)
    expect(containerSource.includes('new PlatformPersistenceFacade(db, path.join(runtimeRoot, \'conversations\'), {')).toBe(true)
    expect(containerSource.includes('runtimeFiles,')).toBe(true)
    expect(containerSource.includes('fileLifecycle,')).toBe(true)
    expect(containerSource.includes('automations: store.automations')).toBe(true)
    expect(containerSource.includes('runtimeConfiguration: store.runtimeConfiguration')).toBe(true)
    expect(runtimePortSource.includes('export interface AgentRuntimeStore')).toBe(true)
    expect(runtimePortSource.includes('export type ToolExecutionStore')).toBe(true)
    for (const relativePath of coreServiceFiles) {
      const source = await readFile(path.join(root, relativePath), 'utf8')
      expect(source.includes('platformPersistenceFacade'), relativePath).toBe(false)
    }
  })

  it('keeps cross-resource conversation lifecycle writes inside repository transactions', async () => {
    const threadSource = await readFile(path.join(process.cwd(), 'src/store/threadStore.ts'), 'utf8')
    const runSource = await readFile(path.join(process.cwd(), 'src/store/runStore.ts'), 'utf8')
    const persistenceSource = await readFile(
      path.join(process.cwd(), 'src/store/postgres/conversationPersistence.ts'),
      'utf8',
    )
    const threadPersistenceSource = await readFile(
      path.join(process.cwd(), 'src/store/postgres/threadLifecycleRepository.ts'),
      'utf8',
    )
    const runPersistenceSource = await readFile(
      path.join(process.cwd(), 'src/store/postgres/runStateRepository.ts'),
      'utf8',
    )

    expect(threadSource.includes('this.repositories.lifecycle.createThreadLifecycle(thread)')).toBe(true)
    expect(threadSource.includes('this.repositories.lifecycle.trashThread(')).toBe(true)
    expect(threadSource.includes('this.sessionStore.update(')).toBe(false)
    expect(runSource.includes('this.repository.createRunLifecycle(run)')).toBe(true)
    expect(runSource.includes('this.repository.saveRunWithCheckpoint(')).toBe(true)
    expect(runSource.includes('this.sessionStore.update(')).toBe(false)

    for (const method of [
      'createThreadLifecycle',
      'trashThread',
      'restoreThread',
      'purgeThread',
    ]) {
      const methodStart = threadPersistenceSource.indexOf(
        `async ${method}(`,
        threadPersistenceSource.indexOf('export class'),
      )
      expect(methodStart, `${method} implementation`).toBeGreaterThanOrEqual(0)
      const transactionStart = threadPersistenceSource.indexOf('this.db.transaction(', methodStart)
      const nextMethodStart = threadPersistenceSource.indexOf('\n  async ', methodStart + 1)
      expect(transactionStart, `${method} transaction`).toBeGreaterThan(methodStart)
      expect(transactionStart, `${method} transaction boundary`).toBeLessThan(nextMethodStart)
    }

    const runMethodStart = runPersistenceSource.indexOf(
      'async createRunLifecycle(',
      runPersistenceSource.indexOf('export class'),
    )
    const runTransactionStart = runPersistenceSource.indexOf('this.db.transaction(', runMethodStart)
    const nextRunMethodStart = runPersistenceSource.indexOf('\n  async ', runMethodStart + 1)
    expect(runTransactionStart, 'createRunLifecycle transaction').toBeGreaterThan(runMethodStart)
    expect(runTransactionStart, 'createRunLifecycle transaction boundary').toBeLessThan(nextRunMethodStart)
  })

  it('injects narrow persistence ports into session, thread, and run stores', async () => {
    const storeRoot = path.join(process.cwd(), 'src/store')
    const portsSource = await readFile(
      path.join(storeRoot, 'postgres/conversationPersistencePorts.ts'),
      'utf8',
    )
    const sessionSource = await readFile(path.join(storeRoot, 'sessionStore.ts'), 'utf8')
    const threadSource = await readFile(path.join(storeRoot, 'threadStore.ts'), 'utf8')
    const runSource = await readFile(path.join(storeRoot, 'runStore.ts'), 'utf8')
    const facadeSource = await readFile(path.join(storeRoot, 'platformPersistenceFacade.ts'), 'utf8')

    for (const port of [
      'ConversationSnapshotRepository',
      'SessionRepository',
      'ThreadLifecycleRepository',
      'ThreadMemoryRepository',
      'ThreadCompactionRepository',
      'ConversationTranscriptRepository',
      'ThreadRepository',
      'RunStateRepository',
      'RunCheckpointRepository',
      'RunRecordRepository',
      'RunRepository',
      'ObjectReferenceRepository',
      'RunInputRepository',
    ]) {
      expect(portsSource.includes(`interface ${port}`), port).toBe(true)
    }
    expect(sessionSource.includes('private readonly repository: SessionRepository')).toBe(true)
    expect(threadSource.includes('private readonly repositories: ThreadPersistencePorts')).toBe(true)
    expect(threadSource.includes('lifecycle: ThreadLifecycleRepository')).toBe(true)
    expect(threadSource.includes('transcript: ConversationTranscriptRepository')).toBe(true)
    expect(threadSource.includes('memory: ThreadMemoryRepository')).toBe(true)
    expect(threadSource.includes('compactions: ThreadCompactionRepository')).toBe(true)
    expect(threadSource.includes("Pick<RunRepository, 'listRunsForThread'>")).toBe(true)
    expect(runSource.includes('private readonly repository: RunRepository')).toBe(true)
    expect(runSource.includes("Pick<ThreadLifecycleRepository, 'saveThread'>")).toBe(true)
    expect(facadeSource.includes('private readonly conversationPersistence: ConversationPersistence')).toBe(false)
    expect(facadeSource.includes('private readonly snapshotRepository: ConversationSnapshotRepository')).toBe(true)
    expect(facadeSource.includes('private readonly runInputRepository: RunInputRepository')).toBe(true)
  })

  it('keeps conversation persistence split by resource ownership without legacy utility facades', async () => {
    const storeRoot = path.join(process.cwd(), 'src/store')
    const persistenceSource = await readFile(
      path.join(storeRoot, 'postgres/conversationPersistence.ts'),
      'utf8',
    )
    const snapshotSource = await readFile(
      path.join(storeRoot, 'postgres/conversationSnapshotRepository.ts'),
      'utf8',
    )
    const sessionSource = await readFile(
      path.join(storeRoot, 'postgres/sessionRepository.ts'),
      'utf8',
    )
    const mapperSource = await readFile(
      path.join(storeRoot, 'postgres/conversationRowMappers.ts'),
      'utf8',
    )
    const threadFacadeSource = await readFile(
      path.join(storeRoot, 'postgres/threadRepository.ts'),
      'utf8',
    )
    const threadLifecycleSource = await readFile(
      path.join(storeRoot, 'postgres/threadLifecycleRepository.ts'),
      'utf8',
    )
    const threadMemorySource = await readFile(
      path.join(storeRoot, 'postgres/threadMemoryRepository.ts'),
      'utf8',
    )
    const threadCompactionSource = await readFile(
      path.join(storeRoot, 'postgres/threadCompactionRepository.ts'),
      'utf8',
    )
    const transcriptSource = await readFile(
      path.join(storeRoot, 'postgres/conversationTranscriptRepository.ts'),
      'utf8',
    )
    const runFacadeSource = await readFile(
      path.join(storeRoot, 'postgres/runRepository.ts'),
      'utf8',
    )
    const runStateSource = await readFile(
      path.join(storeRoot, 'postgres/runStateRepository.ts'),
      'utf8',
    )
    const runCheckpointSource = await readFile(
      path.join(storeRoot, 'postgres/runCheckpointRepository.ts'),
      'utf8',
    )
    const runRecordSource = await readFile(
      path.join(storeRoot, 'postgres/runRecordRepository.ts'),
      'utf8',
    )
    const runDomainJournalSource = await readFile(
      path.join(storeRoot, 'postgres/runDomainJournalRepository.ts'),
      'utf8',
    )

    expect(persistenceSource.includes('new PostgresConversationSnapshotRepository(db)')).toBe(true)
    expect(persistenceSource.includes('new PostgresSessionRepository(db)')).toBe(true)
    expect(persistenceSource.includes('new PostgresThreadRepository(db, this.runMutations)')).toBe(true)
    expect(persistenceSource).toContain(
      'const domainJournal = new PostgresRunDomainJournalRepository(db)',
    )
    expect(persistenceSource).toMatch(
      /new PostgresRunInputRepository\(\s*db,\s*this\.runMutations,\s*inputDelivery,\s*domainJournal,\s*\)/u,
    )
    expect(persistenceSource).toMatch(
      /new PostgresRunRepository\(\s*db,\s*this\.runMutations,\s*this\.runRecords,\s*domainJournal,\s*inputDelivery,\s*\)/u,
    )
    expect(persistenceSource.includes('new PostgresObjectReferenceRepository(db)')).toBe(true)
    expect(persistenceSource.includes('return this.snapshots.loadSnapshot()')).toBe(true)
    expect(persistenceSource.includes('await this.sessions.saveSession(session)')).toBe(true)
    expect(snapshotSource.includes('implements ConversationSnapshotRepository')).toBe(true)
    expect(snapshotSource).toContain("isolationLevel: 'repeatable read'")
    expect(snapshotSource).not.toContain('await Promise.all')
    expect(sessionSource.includes('implements SessionRepository')).toBe(true)
    expect(threadFacadeSource).toContain('implements ThreadRepository')
    expect(threadFacadeSource).toContain('new PostgresThreadLifecycleRepository')
    expect(threadFacadeSource).toContain('new PostgresThreadMemoryRepository')
    expect(threadFacadeSource).toContain('new PostgresThreadCompactionRepository')
    expect(threadFacadeSource).toContain('new PostgresConversationTranscriptRepository')
    expect(threadFacadeSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(threadFacadeSource.includes('this.db.')).toBe(false)
    expect(threadLifecycleSource.includes('platformSessions')).toBe(true)
    expect(threadLifecycleSource.includes('platformThreadMemoryVersions')).toBe(false)
    expect(threadLifecycleSource.includes('platformConversationEntries')).toBe(false)
    expect(threadMemorySource.includes('platformThreadMemoryVersions')).toBe(true)
    expect(threadMemorySource.includes('platformConversationEntries')).toBe(false)
    expect(threadCompactionSource.includes('platformThreadCompactions')).toBe(true)
    expect(threadCompactionSource.includes('platformConversationEntries')).toBe(false)
    expect(transcriptSource.includes('platformConversationEntries')).toBe(true)
    expect(transcriptSource.includes('platformThreadMemoryVersions')).toBe(false)
    expect(runFacadeSource).toContain('implements RunRepository')
    expect(runFacadeSource).toContain('new PostgresRunStateRepository')
    expect(runFacadeSource).toContain('new PostgresRunCheckpointRepository')
    expect(runFacadeSource).toContain('new PostgresRunRecordRepository')
    expect(runFacadeSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(runFacadeSource.includes('this.db.')).toBe(false)
    expect(runStateSource.includes('platformSessions')).toBe(true)
    expect(runStateSource.includes('platformEventOutbox')).toBe(false)
    expect(runCheckpointSource.includes('platformRuns')).toBe(true)
    expect(runCheckpointSource.includes('platformEventOutbox')).toBe(false)
    expect(snapshotSource.includes('platformRunSnapshots')).toBe(true)
    expect(snapshotSource).toContain('mapAuthoritativeRunRows')
    expect(mapperSource).not.toContain('row.stateJson')
    expect(runDomainJournalSource.includes('platformRunSnapshots')).toBe(true)
    expect(runDomainJournalSource).toContain('expectedSequence')
    expect(runDomainJournalSource).toContain('RunDomainSequenceConflictError')
    expect(runRecordSource.includes('platformRunRecords')).toBe(true)
    expect(runRecordSource.includes('platformEventOutbox')).toBe(true)
    expect(await readFile(path.join(storeRoot, 'postgres/objectReferenceRepository.ts'), 'utf8'))
      .toContain('implements ObjectReferenceRepository')
    expect(persistenceSource.includes('this.db.')).toBe(false)
    expect(persistenceSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(mapperSource.includes('export function mapAnalysisRunRow')).toBe(true)
    expect(mapperSource.includes('export function mapThreadRow')).toBe(true)

    await expect(stat(path.join(storeRoot, 'platformStoreUtils.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(storeRoot, 'fileConversationIo.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps map persistence split by scene, layer, and feature ownership', async () => {
    const postgresRoot = path.join(process.cwd(), 'src/store/postgres')
    const facadeSource = await readFile(path.join(postgresRoot, 'mapStore.ts'), 'utf8')
    const sceneSource = await readFile(path.join(postgresRoot, 'mapSceneRepository.ts'), 'utf8')
    const layerSource = await readFile(path.join(postgresRoot, 'mapLayerRepository.ts'), 'utf8')
    const featureSource = await readFile(path.join(postgresRoot, 'mapFeatureRepository.ts'), 'utf8')

    expect(facadeSource.includes('new MapSceneRepository')).toBe(true)
    expect(facadeSource.includes('new MapLayerRepository')).toBe(true)
    expect(facadeSource.includes('new MapFeatureRepository')).toBe(true)
    expect(facadeSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(facadeSource.includes('this.db.')).toBe(false)
    expect(sceneSource.includes('platformMapScenes')).toBe(true)
    expect(sceneSource.includes('platformMapSceneLayers')).toBe(true)
    expect(layerSource.includes('platformMapLayers')).toBe(true)
    expect(featureSource.includes('platformLayerFeatures')).toBe(true)
    expect(featureSource.includes('ST_AsGeoJSON')).toBe(true)
    expect(featureSource.includes('Drizzle query builder 无对应表达式')).toBe(true)
  })

  it('keeps managed layers split into metadata, feature, scene, import, and health boundaries', async () => {
    const managedRoot = path.join(process.cwd(), 'src/gis/managedLayers')
    const facadeSource = await readFile(path.join(managedRoot, 'managedLayerService.ts'), 'utf8')
    const layerSource = await readFile(path.join(managedRoot, 'managedLayerRepository.ts'), 'utf8')
    const featureSource = await readFile(path.join(managedRoot, 'managedFeatureRepository.ts'), 'utf8')
    const sceneSource = await readFile(path.join(managedRoot, 'managedLayerSceneProjection.ts'), 'utf8')
    const importSource = await readFile(path.join(managedRoot, 'managedLayerImportService.ts'), 'utf8')
    const healthSource = await readFile(path.join(managedRoot, 'postGisHealthProbe.ts'), 'utf8')

    expect(facadeSource.includes('new ManagedLayerRepository')).toBe(true)
    expect(facadeSource.includes('new ManagedFeatureRepository')).toBe(true)
    expect(facadeSource.includes('new ManagedLayerImportService')).toBe(true)
    expect(facadeSource.includes('new PostGisHealthProbe')).toBe(true)
    expect(facadeSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(facadeSource.includes('sql`')).toBe(false)

    expect(layerSource.includes('platformMapLayers')).toBe(true)
    expect(layerSource.includes('platformLayerFeatures')).toBe(false)
    expect(featureSource.includes('platformLayerFeatures')).toBe(true)
    expect(featureSource.includes('platformMapLayers')).toBe(false)
    expect(sceneSource.includes('platformMapScenes')).toBe(true)
    expect(sceneSource.includes('platformMapSceneLayers')).toBe(true)

    expect(importSource.includes('this.db.transaction')).toBe(true)
    expect(importSource.includes('this.layers.upsertImportedLayer')).toBe(true)
    expect(importSource.includes('this.features.replaceFeatures')).toBe(true)
    expect(importSource.includes('this.scenes.attach')).toBe(true)
    expect(featureSource.includes('PostGIS 专用能力')).toBe(true)
    expect(healthSource.includes('PostGIS 扩展不可用')).toBe(true)
    await expect(stat(path.join(process.cwd(), 'src/gis/postgis.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps automation persistence split by definition, schedule, and run ownership', async () => {
    const postgresRoot = path.join(process.cwd(), 'src/store/postgres')
    const facadeSource = await readFile(path.join(postgresRoot, 'automationStore.ts'), 'utf8')
    const definitionSource = await readFile(path.join(postgresRoot, 'automationDefinitionRepository.ts'), 'utf8')
    const scheduleSource = await readFile(path.join(postgresRoot, 'scheduledTaskRepository.ts'), 'utf8')
    const runSource = await readFile(path.join(postgresRoot, 'automationRunRepository.ts'), 'utf8')

    expect(facadeSource.includes('new AutomationDefinitionRepository')).toBe(true)
    expect(facadeSource.includes('new ScheduledTaskRepository')).toBe(true)
    expect(facadeSource.includes('new AutomationRunRepository')).toBe(true)
    expect(facadeSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(facadeSource.includes('this.db.')).toBe(false)
    expect(definitionSource.includes('platformAutomationDefinitions')).toBe(true)
    expect(definitionSource.includes('platformAutomationVersions')).toBe(true)
    expect(scheduleSource.includes('platformScheduledTasks')).toBe(true)
    expect(runSource.includes('platformAutomationRuns')).toBe(true)
  })

  it('models artifact publication as an explicit cross-resource transaction', async () => {
    const postgresRoot = path.join(process.cwd(), 'src/store/postgres')
    const publicationSource = await readFile(
      path.join(postgresRoot, 'artifactPublicationRepository.ts'),
      'utf8',
    )
    const metadataSource = await readFile(
      path.join(postgresRoot, 'artifactMetadataRepository.ts'),
      'utf8',
    )
    const mapProjectionSource = await readFile(
      path.join(postgresRoot, 'artifactMapProjectionRepository.ts'),
      'utf8',
    )

    expect(publicationSource.includes('this.db.transaction')).toBe(true)
    expect(publicationSource.includes('this.metadata.upsert')).toBe(true)
    expect(publicationSource.includes('this.mapProjection.publish')).toBe(true)
    expect(publicationSource.includes('platformThreads')).toBe(true)
    expect(metadataSource.includes('platformArtifacts')).toBe(true)
    expect(metadataSource.includes('platformMapLayers')).toBe(false)
    expect(mapProjectionSource.includes('platformMapLayers')).toBe(true)
    expect(mapProjectionSource.includes('platformArtifacts')).toBe(false)
    await expect(stat(path.join(postgresRoot, 'artifactIndexStore.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps meteorological datasets and processing jobs in separate repositories', async () => {
    const postgresRoot = path.join(process.cwd(), 'src/store/postgres')
    const facadeSource = await readFile(path.join(postgresRoot, 'meteorologicalStore.ts'), 'utf8')
    const datasetSource = await readFile(
      path.join(postgresRoot, 'meteorologicalDatasetRepository.ts'),
      'utf8',
    )
    const jobSource = await readFile(
      path.join(postgresRoot, 'meteorologicalJobRepository.ts'),
      'utf8',
    )

    expect(facadeSource.includes('new MeteorologicalDatasetRepository')).toBe(true)
    expect(facadeSource.includes('new MeteorologicalJobRepository')).toBe(true)
    expect(facadeSource.includes("from '../../db/schema.js'")).toBe(false)
    expect(datasetSource.includes('platformMeteorologicalDatasets')).toBe(true)
    expect(datasetSource.includes('platformMeteorologicalJobs')).toBe(false)
    expect(jobSource.includes('platformMeteorologicalJobs')).toBe(true)
    expect(jobSource.includes('platformMeteorologicalDatasets')).toBe(false)
    expect(datasetSource.includes('decodeRequiredRecord')).toBe(true)
    expect(jobSource.includes('decodeRequiredRecord')).toBe(true)
    expect(datasetSource.includes("return value === 'private'")).toBe(false)
    await expect(stat(path.join(postgresRoot, 'meteorologicalDatasetStore.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes obsolete JSONL session facts and unused journal implementations', async () => {
    const storeRoot = path.join(process.cwd(), 'src/store')
    await expect(stat(path.join(storeRoot, 'sessionLog.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(storeRoot, 'journal.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats the in-memory conversation index as a rebuildable projection, not a store fact source', async () => {
    const storeRoot = path.join(process.cwd(), 'src/store')
    const projectionSource = await readFile(path.join(storeRoot, 'conversationProjectionIndex.ts'), 'utf8')
    const errorsSource = await readFile(path.join(storeRoot, 'storeErrors.ts'), 'utf8')

    expect(projectionSource.includes('export class ConversationProjectionIndex')).toBe(true)
    expect(projectionSource.includes('PostgreSQL 会话仓储是事实源')).toBe(true)
    expect(projectionSource.includes('export class StoreNotFoundError')).toBe(false)
    expect(errorsSource.includes('export class StoreNotFoundError')).toBe(true)
    await expect(stat(path.join(storeRoot, 'conversationIndexStore.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(storeRoot, 'fileConversationStore.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(storeRoot, 'ConversationStorage.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps ConversationPayloadStore compiled against the ConversationPayloadStorage port', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/store/conversationPayloadStore.ts'), 'utf8')
    const portSource = await readFile(path.join(process.cwd(), 'src/store/conversationPayloadStorage.ts'), 'utf8')
    const persistenceSource = await readFile(path.join(process.cwd(), 'src/store/postgres/conversationPersistence.ts'), 'utf8')

    expect(source.includes('export class ConversationPayloadStore implements ConversationPayloadStorage')).toBe(true)
    expect(source.includes('隐式满足 ConversationPayloadStorage')).toBe(false)
    expect(portSource.includes('saveRun(')).toBe(false)
    expect(portSource.includes('saveAgentsSdkCheckpointEnvelope(')).toBe(false)
    expect(portSource.includes('saveMemory(')).toBe(false)
    expect(portSource.includes('appendTranscript(')).toBe(false)
    expect(portSource.includes('appendCompaction(')).toBe(false)
    expect(portSource.includes('registerThread(')).toBe(true)
    expect(portSource.includes('readObjectByHash(')).toBe(true)
    expect(portSource.includes('appendValue(runId: string, value: ToolValueRef)')).toBe(false)
    expect(persistenceSource.includes('saveRunCheckpoint(')).toBe(true)
    expect(persistenceSource.includes('saveAgentsSdkCheckpoint(')).toBe(true)
    expect(persistenceSource.includes('saveThreadMemoryVersion(')).toBe(true)
    expect(persistenceSource.includes('appendCompaction(')).toBe(true)
  })

  it('hydrates file payload locations from PostgreSQL without recovering legacy conversation JSONL', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/store/conversationPayloadStore.ts'), 'utf8')
    const facadeSource = await readFile(path.join(process.cwd(), 'src/store/platformPersistenceFacade.ts'), 'utf8')
    const jsonlSource = await readFile(path.join(process.cwd(), 'src/store/durableJsonlStore.ts'), 'utf8')
    const threadSource = await readFile(path.join(process.cwd(), 'src/store/threadStore.ts'), 'utf8')

    expect(source.includes('async initialize(snapshot: ConversationPayloadIndex)')).toBe(true)
    expect(source.includes('for (const thread of snapshot.threads)')).toBe(true)
    expect(source.includes('for (const deleted of snapshot.deletedThreads)')).toBe(true)
    expect(source.includes('for (const run of snapshot.runs)')).toBe(true)
    expect(facadeSource.indexOf('this.snapshotRepository.loadSnapshot()'))
      .toBeLessThan(facadeSource.indexOf('this.payloadStore.initialize(snapshot)'))
    expect(source.includes('new DurableJsonlStore()')).toBe(true)
    expect(source.includes('this.jsonlStore.append')).toBe(true)
    expect(source.includes('this.jsonlStore.read')).toBe(false)
    expect(source.includes('ThreadJournalStore')).toBe(false)
    expect(source.includes('ThreadMemoryFileStore')).toBe(false)
    expect(source.includes('thread.json')).toBe(false)
    expect(threadSource.includes('this.repositories.memory.saveThreadMemoryVersion')).toBe(true)
    expect(threadSource.includes('this.repositories.compactions.appendCompaction')).toBe(true)
    expect(threadSource.includes('this.payloadStore.putObject')).toBe(true)
    expect(threadSource.includes('this.payloadStore.readObjectByHash')).toBe(true)
    expect(jsonlSource.includes('private readonly writeQueues')).toBe(true)
    for (const token of [
      'private writeQueues',
      'private enqueueAppend',
      'private async readJsonLines',
      'threadJournalSchema =',
      'private async writeThreadJournal',
      'private async applyThreadJournal',
      'private async recoverThreadJournals',
      'recordJsonLineCorruption(',
      'memory 版本冲突',
      'versions.jsonl',
      'compactions.jsonl',
      'previous append failed',
    ]) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('uses PostgreSQL advisory locking for the single API writer boundary', async () => {
    const lockSource = await readFile(path.join(process.cwd(), 'src/db/applicationInstanceLock.ts'), 'utf8')
    const containerSource = await readFile(path.join(process.cwd(), 'src/app/container.ts'), 'utf8')
    const packageSource = await readFile(path.join(process.cwd(), 'package.json'), 'utf8')

    expect(lockSource.includes('pg_advisory_lock')).toBe(true)
    expect(lockSource.includes('pg_advisory_unlock')).toBe(true)
    expect(containerSource.includes('await instanceLock.acquire()')).toBe(true)
    expect(packageSource.includes('proper-lockfile')).toBe(false)
  })

  it('keeps content-addressed object IO outside ConversationPayloadStore', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/store/conversationPayloadStore.ts'), 'utf8')
    const objectSource = await readFile(path.join(process.cwd(), 'src/store/contentAddressedObjectStore.ts'), 'utf8')
    const gcSource = await readFile(path.join(process.cwd(), 'src/store/conversationObjectGarbageCollector.ts'), 'utf8')

    expect(source.includes('new ContentAddressedObjectStore(this.objectsRoot)')).toBe(true)
    expect(source.includes('new ConversationObjectGarbageCollector(this.sessionsRoot, this.objectsRoot)')).toBe(true)
    expect(source.includes('return this.objectStore.put(content, mediaType)')).toBe(true)
    expect(source.includes('return this.objectStore.read(reference)')).toBe(true)
    expect(source.includes('return this.objectStore.readByHash(hash)')).toBe(true)
    expect(source.includes('return this.objectGarbageCollector.collect(databaseReferences)')).toBe(true)
    expect(gcSource.includes('databaseReferences: Iterable<string>')).toBe(true)
    expect(objectSource.includes("createHash('sha256')")).toBe(true)
    expect(gcSource.includes('collectAttachmentReferences')).toBe(true)
    for (const token of [
      "createHash('sha256')",
      "writeFile(target, bytes, { flag: 'wx' })",
      'actualHash',
      'contentRef 哈希格式无效',
      'content.matchAll',
      'collectAttachmentReferences',
    ]) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps WebSocket handler as transport-only and command-registry driven', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/ws/handler.ts'), 'utf8')
    const required = [
      'createDefaultCommandRegistry()',
      'commandRegistry.get(msg.type)',
      'commandRegistry.execute(msg',
    ]
    const forbidden = [
      'switch (msg.type)',
      'case ',
      'function handleMessage',
      'async function handleMessage',
      'executeTool(',
      'registerCoreCommands(',
      'registerThreadCommands(',
      'registerRunCommands(',
      'registerMemoryCommands(',
      'registerToolCommands(',
    ]

    for (const token of required) {
      expect(source.includes(token), token).toBe(true)
    }
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
    expect(source.includes('security.auth.authenticateHeaders(headers)')).toBe(true)
    expect(source.includes('security.auth.authenticateLocalAgentHeaders(headers)')).toBe(true)
    expect(source.includes('isLoopbackAddress(request.socket.remoteAddress)')).toBe(true)
    expect(source.includes('new URL(request.url')).toBe(false)
    expect(source.includes('new Request(')).toBe(false)
  })

  it('keeps WebSocket authorization attached to the command registry', async () => {
    const securitySource = await readFile(path.join(process.cwd(), 'src/ws/security.ts'), 'utf8')
    const registrySource = await readFile(path.join(process.cwd(), 'src/ws/defaultCommandRegistry.ts'), 'utf8')
    expect(securitySource.includes('registerWsAuthorizationPolicies')).toBe(true)
    expect(registrySource.includes('registerWsAuthorizationPolicies(registry)')).toBe(true)
    expect(securitySource.includes('switch (msg.type)')).toBe(false)
    expect(securitySource.includes('authorizeWsMessage')).toBe(false)
    expect(securitySource.includes('MUTATING_COMMANDS')).toBe(false)
  })

  it('keeps ToolRegistry construction in the application composition root', async () => {
    const registrySource = await readFile(path.join(process.cwd(), 'src/framework/registry.ts'), 'utf8')
    const loaderSource = await readFile(path.join(process.cwd(), 'src/framework/loader.ts'), 'utf8')
    const containerSource = await readFile(path.join(process.cwd(), 'src/app/container.ts'), 'utf8')

    expect(registrySource.includes('export const toolRegistry = new ToolRegistry')).toBe(false)
    expect(loaderSource.includes("import { getEnv } from './env.js'")).toBe(false)
    expect(loaderSource.includes("import { toolRegistry } from './registry.js'")).toBe(false)
    expect(loaderSource.includes('deps: { env: Env; registry: ToolRegistry; scheduledTaskService?: ScheduledTaskService }')).toBe(true)
    expect(containerSource.includes('const toolRegistry = new ToolRegistry()')).toBe(true)
  })

  it('keeps application service construction inside AppContainer', async () => {
    const mainSource = await readFile(path.join(process.cwd(), 'src/main.ts'), 'utf8')
    const containerSource = await readFile(path.join(process.cwd(), 'src/app/container.ts'), 'utf8')
    const forbiddenMainTokens = [
      'new PlatformPersistenceFacade',
      'new ManagedLayerService',
      'new ArtifactPublicationRepository',
      'new AuditStore',
      'new BetterAuthService',
      'new AuthorizationService',
      'new ToolRegistry',
      'new ModelAdapterRegistry',
      'await store.initialize',
      'await discoverAndLoad',
      'await validateToolContracts',
    ]

    expect(mainSource.includes('createAppContainer')).toBe(true)
    expect(containerSource.includes('export async function createAppContainer')).toBe(true)
    for (const token of forbiddenMainTokens) {
      expect(mainSource.includes(token), token).toBe(false)
    }
  })

  it('keeps runtime env reads in the composition root, not WS or provider modules', async () => {
    const forbiddenFiles = [
      'src/ws/controlCommands.ts',
      'src/ws/dependencies.ts',
      'src/tools/spatial/index.ts',
      'src/tools/routing/index.ts',
      'src/tools/media/index.ts',
      'src/tools/media/mediaTools.ts',
      'src/tools/meteorology/index.ts',
      'src/tools/meteorology/meteorologyTools.ts',
      'src/tools/meteorology/meteorologyWorkerClient.ts',
      'src/tools/publicWeather/index.ts',
      'src/tools/publicWeather/handler.ts',
      'src/tools/publicWeather/openMeteoClient.ts',
    ]

    for (const relativePath of forbiddenFiles) {
      const source = await readFile(path.join(process.cwd(), relativePath), 'utf8')
      expect(source.includes('getEnv()'), relativePath).toBe(false)
      expect(source.includes("import { getEnv }"), relativePath).toBe(false)
    }
  })

  it('keeps meteorology HTTP routes delegated to resource stores instead of raw CRUD SQL', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/routes/meteorology.ts'), 'utf8')
    const forbidden = [
      'db.execute(sql`',
      'SELECT *',
      'INSERT INTO platform_meteorological_datasets',
      'INSERT INTO platform_meteorological_jobs',
    ]

    expect(source.includes('store.meteorology.listMeteorologicalDatasets')).toBe(true)
    expect(source.includes('store.createMeteorologicalDataset')).toBe(true)
    expect(source.includes('store.meteorology.getMeteorologicalJob')).toBe(true)
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps meteorology tool definition DSL outside the tool handler module', async () => {
    const toolSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/meteorologyTools.ts'), 'utf8')
    const definitionSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/toolDefinition.ts'), 'utf8')

    expect(toolSource.includes("from './toolDefinition.js'")).toBe(true)
    for (const token of [
      "import { meteorologyToolPrompt } from './prompts.js'",
      'function tool(',
      'function refParameter(',
      'function textParameter(',
      'function numberParameter(',
      'function selectParameter(',
      'function jsonParameter(',
      'function miniAppMetadata(',
    ]) {
      expect(toolSource.includes(token), token).toBe(false)
    }
    for (const token of [
      'meteorologyToolPrompt(name)',
      'export function tool(',
      'export function refParameter(',
      'function miniAppMetadata(',
    ]) {
      expect(definitionSource.includes(token), token).toBe(true)
    }
  })

  it('keeps nowcast scope tools region-generic instead of Hangzhou-specific', async () => {
    const providerSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/meteorologyTools.ts'), 'utf8')
    const toolSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/nowcastTools.ts'), 'utf8')
    const promptSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/prompts.ts'), 'utf8')
    const manifestSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/manifest.json'), 'utf8')
    const nowcastSource = await readFile(path.join(process.cwd(), '../../packages/gis-meteorology/src/gis_meteorology/nowcast.py'), 'utf8')

    expect(providerSource.includes('createNowcastMeteorologyTools')).toBe(true)
    for (const [name, source] of Object.entries({ toolSource, promptSource, manifestSource })) {
      expect(source.includes('prepare_nowcast_scope'), name).toBe(true)
      expect(source.includes('prepare_hangzhou_nowcast_scope'), name).toBe(false)
      expect(source.includes('HANGZHOU_DISTRICTS'), name).toBe(false)
      expect(source.includes('杭州区划'), name).toBe(false)
      expect(source.includes('杭州地点'), name).toBe(false)
    }
    expect(nowcastSource.includes('杭州短时临近预报')).toBe(false)
    expect(nowcastSource.includes('杭州天气怎么样')).toBe(false)
    expect(nowcastSource.includes('短时临近预报（短临）分析区域')).toBe(true)
  })

  it('keeps meteorology provider split by tool ownership', async () => {
    const providerSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/meteorologyTools.ts'), 'utf8')
    const datasetSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/datasetTools.ts'), 'utf8')
    const radarSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/radarTools.ts'), 'utf8')
    const nowcastSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/nowcastTools.ts'), 'utf8')
    const runtimeSource = await readFile(path.join(process.cwd(), 'src/tools/meteorology/toolRuntime.ts'), 'utf8')

    expect(providerSource.includes('createDatasetMeteorologyTools')).toBe(true)
    expect(providerSource.includes('createRadarMeteorologyTools')).toBe(true)
    expect(providerSource.includes('createNowcastMeteorologyTools')).toBe(true)
    for (const token of [
      'function workerDatasetTool',
      'async function inspectRadarStationCollection',
      'async function createNowcastSequence',
      'async function generateReport',
      'function requiredRefKind',
      'function artifactTarget',
    ]) {
      expect(providerSource.includes(token), token).toBe(false)
    }
    expect(datasetSource.includes('function workerDatasetTool')).toBe(true)
    expect(radarSource.includes('async function inspectRadarStationCollection')).toBe(true)
    expect(nowcastSource.includes('async function createNowcastSequence')).toBe(true)
    expect(runtimeSource.includes('export function requiredRefKind')).toBe(true)
    expect(runtimeSource.includes('export function artifactTarget')).toBe(true)
  })

  it('keeps security admin resources split behind an injected application service', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/security/routes.ts'), 'utf8')
    const serviceSource = await readFile(path.join(process.cwd(), 'src/security/adminService.ts'), 'utf8')
    const containerSource = await readFile(path.join(process.cwd(), 'src/app/container.ts'), 'utf8')
    const userSource = await readFile(path.join(process.cwd(), 'src/store/postgres/platformUserRepository.ts'), 'utf8')
    const workspaceSource = await readFile(path.join(process.cwd(), 'src/store/postgres/workspaceRepository.ts'), 'utf8')
    const membershipSource = await readFile(path.join(process.cwd(), 'src/store/postgres/membershipRepository.ts'), 'utf8')
    const policySource = await readFile(path.join(process.cwd(), 'src/store/postgres/rbacPolicyReader.ts'), 'utf8')
    const forbidden = [
      'services.db.execute',
      'new SecurityAdminStore',
      'db.execute(sql`',
      'SELECT * FROM platform_workspaces',
      'INSERT INTO platform_workspaces',
      'INSERT INTO platform_memberships',
      'DELETE FROM platform_memberships',
    ]

    expect(source.includes('services.admin.listUsers()')).toBe(true)
    expect(source.includes("zValidator('json', adminUserPatchSchema")).toBe(true)
    expect(source.includes("zValidator('json', adminWorkspaceCreateSchema")).toBe(true)
    expect(source.includes("zValidator('json', adminMembershipCreateSchema")).toBe(true)
    expect(serviceSource.includes('this.dependencies.db.transaction')).toBe(true)
    expect(serviceSource.includes('this.dependencies.workspaces.insert')).toBe(true)
    expect(serviceSource.includes('this.dependencies.memberships.insert')).toBe(true)
    expect(serviceSource.includes('platformUsers')).toBe(false)
    expect(userSource.includes('platformUsers')).toBe(true)
    expect(userSource.includes('platformWorkspaces')).toBe(false)
    expect(workspaceSource.includes('platformWorkspaces')).toBe(true)
    expect(membershipSource.includes('platformMemberships')).toBe(true)
    expect(policySource.includes('platformRbacPolicies')).toBe(true)
    expect(containerSource.includes('new SecurityAdminService')).toBe(true)
    await expect(stat(path.join(process.cwd(), 'src/security/adminStore.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps BetterAuth delegated to a transactional identity service with resource-owned repositories', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/security/authService.ts'), 'utf8')
    const serviceSource = await readFile(path.join(process.cwd(), 'src/security/platformIdentityService.ts'), 'utf8')
    const containerSource = await readFile(path.join(process.cwd(), 'src/app/container.ts'), 'utf8')
    const sessionSource = await readFile(path.join(process.cwd(), 'src/store/postgres/authSessionRepository.ts'), 'utf8')
    const userSource = await readFile(path.join(process.cwd(), 'src/store/postgres/platformUserRepository.ts'), 'utf8')
    const membershipSource = await readFile(path.join(process.cwd(), 'src/store/postgres/membershipRepository.ts'), 'utf8')
    const forbidden = [
      'db.execute',
      'sql`',
      'platform_users',
      'platform_workspaces',
      'platform_memberships',
      'auth_session',
    ]

    expect(source.includes('this.identity.ensureProjection(')).toBe(true)
    expect(source.includes('new PlatformIdentityStore')).toBe(false)
    expect(serviceSource.includes('this.dependencies.db.transaction')).toBe(true)
    expect(serviceSource.includes('this.dependencies.users.upsertIdentityProjection')).toBe(true)
    expect(serviceSource.includes('this.dependencies.workspaces.ensurePersonal')).toBe(true)
    expect(serviceSource.includes('this.dependencies.memberships.insert')).toBe(true)
    expect(serviceSource.includes('platformUsers')).toBe(false)
    expect(serviceSource.includes('platformWorkspaces')).toBe(false)
    expect(serviceSource.includes('platformMemberships')).toBe(false)
    expect(sessionSource.includes('authSession')).toBe(true)
    expect(sessionSource.includes('platformUsers')).toBe(false)
    expect(userSource.includes('platformUsers')).toBe(true)
    expect(userSource.includes('platformWorkspaces')).toBe(false)
    expect(membershipSource.includes('platformMemberships')).toBe(true)
    expect(containerSource.includes('new PlatformIdentityService')).toBe(true)
    expect(containerSource.includes('new BetterAuthService({ db, env, identity: identityService })')).toBe(true)
    await expect(stat(path.join(process.cwd(), 'src/security/platformIdentityStore.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps artifact HTTP routes delegated to the narrow ArtifactReader boundary', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/routes/artifacts.ts'), 'utf8')
    const forbidden = [
      'db.execute',
      'sql`',
      'FROM platform_artifacts',
      'SELECT artifact_id',
    ]

    expect(source.includes('artifacts.getArtifact')).toBe(true)
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps Casbin policy persistence on the Drizzle schema boundary', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/security/casbinPostgresAdapter.ts'), 'utf8')
    const forbidden = [
      'db.execute',
      'sql`',
      'platform_rbac_policies',
      'SELECT ptype',
      'INSERT INTO platform_rbac_policies',
      'DELETE FROM platform_rbac_policies',
    ]

    expect(source.includes('platformRbacPolicies')).toBe(true)
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps authorization audit writes delegated to AuditStore', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/security/authorizationService.ts'), 'utf8')
    const containerSource = await readFile(path.join(process.cwd(), 'src/app/container.ts'), 'utf8')
    const forbidden = [
      'db.execute',
      'sql`',
      'platform_audit_events',
      'INSERT INTO platform_audit_events',
    ]

    expect(source.includes('private readonly auditStore: AuditStore')).toBe(true)
    expect(source.includes('this.auditStore.recordEvent')).toBe(true)
    expect(containerSource.includes('const auditStore = new AuditStore(db)')).toBe(true)
    expect(containerSource.includes('new AuthorizationService(db, auditStore)')).toBe(true)
    for (const token of forbidden) {
      expect(source.includes(token), token).toBe(false)
    }
  })

  it('keeps server and worker observability on the structured logging boundary', async () => {
    const root = path.resolve(process.cwd(), '..', '..')
    const serverFiles = await collectSourceFiles([path.join(root, 'apps/server/src')])
    const mainSource = await readFile(path.join(root, 'apps/server/src/main.ts'), 'utf8')
    const wsSource = await readFile(path.join(root, 'apps/server/src/ws/handler.ts'), 'utf8')
    const workerClientSource = await readFile(path.join(root, 'apps/server/src/tools/meteorology/meteorologyWorkerClient.ts'), 'utf8')
    const workerSidecarSource = await readFile(path.join(root, 'apps/worker/src/worker_app/sidecar.py'), 'utf8')
    const workerLoggingSource = await readFile(path.join(root, 'apps/worker/src/worker_app/logging.py'), 'utf8')

    const interactiveConsoleFiles = new Set([
      path.join(root, 'apps/server/src/operations/localConsole.tsx'),
      path.join(root, 'apps/server/src/operations/localConsoleEntry.ts'),
    ])
    for (const file of serverFiles.filter(file => !/\.test\.ts$/u.test(file) && !interactiveConsoleFiles.has(file))) {
      const source = await readFile(file, 'utf8')
      expect(/\bconsole\.(?:debug|error|info|log|trace|warn)\s*\(/u.test(source), file).toBe(false)
    }
    expect(mainSource.includes("c.header('x-geo-agent-platform-trace-id'")).toBe(true)
    expect(mainSource.includes('withLogContext')).toBe(true)
    expect(wsSource.includes('withLogContext')).toBe(true)
    expect(wsSource.includes('wsMessagesTotal')).toBe(true)
    expect(workerClientSource.includes("'x-geo-agent-platform-trace-id'")).toBe(true)
    expect(workerSidecarSource.includes('from worker_app.logging import configure_logging')).toBe(true)
    expect(workerSidecarSource.includes('class WorkerJsonFormatter')).toBe(false)
    expect(workerLoggingSource.includes('class WorkerJsonFormatter')).toBe(true)
    expect(workerSidecarSource.includes('"runtimeRoot": str(RUNTIME_ROOT)')).toBe(false)
  })

  it('keeps worker sidecar thin and delegates infrastructure boundaries', async () => {
    const root = path.resolve(process.cwd(), '..', '..')
    const sidecarPath = path.join(root, 'apps/worker/src/worker_app/sidecar.py')
    const sidecarSource = await readFile(sidecarPath, 'utf8')
    const appFactorySource = await readFile(path.join(root, 'apps/worker/src/worker_app/app_factory.py'), 'utf8')
    const registrySource = await readFile(path.join(root, 'apps/worker/src/worker_app/tool_registry.py'), 'utf8')
    const builtinToolsSource = await readFile(path.join(root, 'apps/worker/src/worker_app/tools/__init__.py'), 'utf8')
    const inspectToolSource = await readFile(path.join(root, 'apps/worker/src/worker_app/tools/meteorological_inspect.py'), 'utf8')
    const pathSandboxSource = await readFile(path.join(root, 'apps/worker/src/worker_app/path_sandbox.py'), 'utf8')
    const authSource = await readFile(path.join(root, 'apps/worker/src/worker_app/worker_auth.py'), 'utf8')
    const requestArgsSource = await readFile(path.join(root, 'apps/worker/src/worker_app/request_args.py'), 'utf8')
    const nowcastBridgeSource = await readFile(path.join(root, 'apps/worker/src/worker_app/nowcast_bridge.py'), 'utf8')

    expect(sidecarSource.includes('create_worker_app(WorkerSettings.from_env())')).toBe(true)
    expect(appFactorySource.includes('WorkerPathSandbox')).toBe(true)
    expect(appFactorySource.includes('WorkerAuthVerifier')).toBe(true)
    expect(appFactorySource.includes('register_system_routes(')).toBe(true)
    expect(appFactorySource.includes('register_tool_routes(')).toBe(true)
    expect(appFactorySource.includes('register_builtin_tools(tool_registry)')).toBe(true)
    expect(registrySource.includes('class WorkerToolRegistry')).toBe(true)
    expect(builtinToolsSource.includes('_BUILTIN_TOOL_REGISTRARS')).toBe(true)
    expect(inspectToolSource.includes('from worker_app.sidecar import')).toBe(false)
    for (const token of [
      '@worker_tool',
      '@app.get("/health")',
      '@app.get("/tools/catalog")',
      '@app.post("/tools/{tool_name}")',
      'class ToolRequest',
      'def resolve_runtime_path',
      'def safe_relative_path',
      'def safe_path_segment',
      'def _verify_worker_authorization',
      'class WorkerJsonFormatter',
      'def required_float',
      'def nowcast_sequence_from_reference',
    ]) {
      expect(sidecarSource.includes(token), token).toBe(false)
    }
    expect(pathSandboxSource.includes('class WorkerPathSandbox')).toBe(true)
    expect(authSource.includes('class WorkerAuthVerifier')).toBe(true)
    expect(requestArgsSource.includes('def required_float')).toBe(true)
    expect(nowcastBridgeSource.includes('def nowcast_sequence_from_reference')).toBe(true)
  })

  it('keeps Agent runtime services behind narrow persistence ports', async () => {
    const root = path.resolve(process.cwd(), '..', '..')
    const runtimePortSource = await readFile(path.join(root, 'apps/server/src/store/runtimePorts.ts'), 'utf8')
    const productionFiles = [
      'apps/server/src/agent/runtime.ts',
      'apps/server/src/agent/contextManager.ts',
      'apps/server/src/agent/toolExecutionCoordinator.ts',
      'apps/server/src/agent/runTaskManager.ts',
      'apps/server/src/memory/service.ts',
      'apps/server/src/tools/resultPersistence.ts',
    ]

    expect(runtimePortSource.includes('interface AgentRuntimeStore')).toBe(true)
    expect(runtimePortSource.includes('type ToolExecutionStore')).toBe(true)
    expect(runtimePortSource.includes('type ThreadContextStore')).toBe(true)
    for (const relativePath of productionFiles) {
      const source = await readFile(path.join(root, relativePath), 'utf8')
      expect(source.includes("from '../store/platformPersistenceFacade.js'"), relativePath).toBe(false)
      expect(source.includes("from '../store/runtimePorts.js'"), relativePath).toBe(true)
    }
  })

  it('keeps Agents SDK orchestration in the native runtime boundaries', async () => {
    const root = path.resolve(process.cwd(), '..', '..')
    const runtimeSource = await readFile(path.join(root, 'apps/server/src/agent/runtime.ts'), 'utf8')
    const assemblySource = await readFile(path.join(root, 'apps/server/src/agent/runtimeAssembly.ts'), 'utf8')
    const executorSource = await readFile(path.join(root, 'apps/server/src/agent/runtimeSdkExecutor.ts'), 'utf8')
    const inputSource = await readFile(path.join(root, 'apps/server/src/agent/runtimeModelInput.ts'), 'utf8')
    const projectorSource = await readFile(path.join(root, 'apps/server/src/agent/runtimeTranscriptProjector.ts'), 'utf8')
    const subAgentSource = await readFile(path.join(root, 'apps/server/src/agent/subAgentToolFactory.ts'), 'utf8')
    const handoffSource = await readFile(path.join(root, 'apps/server/src/agent/handoffAgentFactory.ts'), 'utf8')
    const integrationSource = await readFile(path.join(root, 'apps/server/src/agent/runtimeSdkIntegrations.ts'), 'utf8')
    const sharedRuntimeSource = await readFile(path.join(root, 'packages/shared-types/src/runtime.ts'), 'utf8')

    expect(runtimeSource).toContain('RuntimeAssemblyFactory')
    expect(runtimeSource).toContain('RuntimeSdkExecutor')
    expect(runtimeSource).not.toContain('new Runner(')
    expect(runtimeSource).not.toContain('.runner.run(')
    expect(assemblySource).toContain('new Runner(')
    expect(executorSource).toContain('assembly.runner.run(')
    expect(inputSource).toContain('class RuntimeModelInputController')
    expect(projectorSource).toContain('class RuntimeTranscriptProjector')
    expect(subAgentSource).toContain('.asTool(')
    expect(handoffSource).toContain('handoff(')
    expect(integrationSource).toContain('connectMcpServers')
    expect(integrationSource).toContain('getAllMcpTools')

    const retiredFactory = path.join(root, 'apps/server/src/agent/parallelSubAgentToolFactory.ts')
    await expect(stat(retiredFactory)).rejects.toMatchObject({ code: 'ENOENT' })
    const retiredTokens = [
      'delegate_agent_batch',
      'parallel_batch',
      'maxParallelSubAgents',
      'AgentBatch',
      'hostedMcpTool',
      'connectorId',
    ]
    const activeContracts = [
      assemblySource,
      executorSource,
      subAgentSource,
      handoffSource,
      integrationSource,
      sharedRuntimeSource,
    ].join('\n')
    for (const token of retiredTokens) {
      expect(activeContracts, token).not.toContain(token)
    }
  })

  it('keeps short-nowcast orchestration in the generic Automation boundary', async () => {
    const root = path.resolve(process.cwd(), '..', '..')
    const dedicatedRunner = path.join(root, 'apps/server/src/agent/deterministicNowcastRunner.ts')
    const runtimeSource = await readFile(path.join(root, 'apps/server/src/agent/runtime.ts'), 'utf8')
    const automation = automationDefinitionSchema.parse(JSON.parse(await readFile(
      path.join(root, 'apps/server/config/automations/meteorological_nowcast_monitor.json'),
      'utf8',
    )))

    await expect(stat(dedicatedRunner)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(runtimeSource).not.toContain('shouldRunDeterministicNowcast')
    expect(runtimeSource).not.toContain('runDeterministicNowcast')
    expect(automation.revision).toBe(8)
    expect(automation.defaultParameters.horizonMinutes).toBe(180)
    expect(automation.defaultParameters).not.toHaveProperty('regionLayerKey')
    expect(automation.requiredTools).not.toContain('query_layer')
    expect(automation.agentInvocation.enabled).toBe(true)
    expect(automation.agentInvocation.requirements).toEqual([{
      resource: 'meteorological_files',
      scope: 'thread',
      minimumCount: 2,
      readyOnly: true,
    }])
    expect(automation.graph.nodes.some(node => node.type === 'agent')).toBe(false)
    expect(automation.graph.nodes.some(node => node.type === 'tool' && node.config.toolName === 'answer_nowcast_question')).toBe(true)
    const files = automation.graph.nodes.find(node => node.nodeId === 'list_files')
    if (!files || files.type !== 'tool') throw new Error('短临 Automation 缺少气象文件目录节点')
    expect(files.config.arguments.scope).toEqual({ source: 'literal', value: 'thread' })
    expect(automation.graph.nodes.some(node => node.nodeId === 'query_scope')).toBe(false)
    expect(automation.graph.nodes.some(node => node.type === 'tool' && node.config.toolName === 'query_layer')).toBe(false)
    const sequence = automation.graph.nodes.find(node => node.nodeId === 'create_sequence')
    if (!sequence || sequence.type !== 'tool') throw new Error('短临 Automation 缺少序列创建节点')
    expect(sequence.config.arguments.horizon_minutes).toEqual({
      source: 'input',
      path: 'parameters.horizonMinutes',
    })
    const nowcast = automation.graph.nodes.find(node => node.nodeId === 'nowcast')
    if (!nowcast || nowcast.type !== 'tool') throw new Error('短临 Automation 缺少降水分析节点')
    expect(nowcast.config.arguments).not.toHaveProperty('scope_ref')
    expect(automation.graph.edges).toContainEqual(expect.objectContaining({
      edgeId: 'list-create',
      sourceNodeId: 'list_files',
      targetNodeId: 'create_sequence',
    }))
    const output = automation.graph.nodes.find(node => node.type === 'output')
    expect(output?.type === 'output' && Object.hasOwn(output.config.outputs, 'answer')).toBe(true)
    expect(output?.type === 'output' && Object.hasOwn(output.config.outputs, 'warnings')).toBe(true)
    const automationTool = (name: string): ToolDef => ({
      name,
      label: name,
      description: name,
      prompt: name,
      group: '验收',
      tags: [],
      isReadOnly: true,
      isDestructive: false,
      executionSurfaces: ['automation'],
      jsonSchema: { type: 'object', properties: {} },
      handler: async () => ({ message: '完成', payload: {}, warnings: [], resultId: 'result', source: 'test' }),
    })
    expect(new AutomationCompiler({ get: name => automationTool(name) }).validate(automation))
      .toMatchObject({ valid: true })
  })

  it('replays completed conversation items from the PostgreSQL repository', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'geo-items-'))
    try {
      const harness = new PersistenceFacadeTestHarness()
      const store = harness.create(dir)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '测试')
      const run = await store.createRun(session.id, '查询杭州', { threadId: thread.id })

      await store.appendItem(item({ runId: run.id, threadId: thread.id, role: 'user', body: '查询杭州' }))
      await store.appendItem(item({ runId: run.id, threadId: thread.id, role: 'assistant', body: '杭州有雨。' }))
      await store.appendItem(item({ runId: run.id, threadId: thread.id, itemType: 'result', role: null, body: null, metadata: { resultType: 'success' } }))
      await store.flushConversationStore()

      const restored = harness.create(dir)
      await restored.initialize()
      const restoredItems = await restored.listItems(run.id)

      expect(restoredItems.map((entry) => entry.itemType)).toEqual(['message', 'message', 'result'])
      expect(restoredItems[1].body).toBe('杭州有雨。')
      expect(restoredItems[2].body).toBeNull()
      expect(restored.getThread(thread.id).latestAssistantSummary).toBe('杭州有雨。')
    } finally {
      await removeTempDirectory(dir)
    }
  })

  it('builds run WebSocket snapshots from one strict presentation replay', async () => {
    const repositoryRoot = path.resolve(process.cwd(), '..', '..')
    const subscriptionsSource = await readFile(
      path.join(repositoryRoot, 'apps/server/src/ws/subscriptions.ts'),
      'utf8',
    )
    const repositorySource = await readFile(
      path.join(repositoryRoot, 'apps/server/src/store/postgres/runRecordRepository.ts'),
      'utf8',
    )
    const projectionSource = await readFile(
      path.join(repositoryRoot, 'packages/shared-types/src/runPresentation.ts'),
      'utf8',
    )
    const transcriptSource = await readFile(
      path.join(repositoryRoot, 'apps/server/src/store/postgres/conversationTranscriptRepository.ts'),
      'utf8',
    )
    const runDomainJournalSource = await readFile(
      path.join(repositoryRoot, 'apps/server/src/store/postgres/runDomainJournalRepository.ts'),
      'utf8',
    )
    const platformFacadeSource = await readFile(
      path.join(repositoryRoot, 'apps/server/src/store/platformPersistenceFacade.ts'),
      'utf8',
    )

    expect(subscriptionsSource).toContain('store.listPresentationSnapshot(runId)')
    expect(subscriptionsSource).not.toContain('store.listItemSnapshot(runId)')
    expect(repositorySource).toContain('nextRecordSequence: platformRuns.nextRecordSequence')
    expect(repositorySource).toContain('replayRunPresentationRecords(records)')
    expect(projectionSource).toContain('record.sequence !== expectedSequence')
    expect(projectionSource).toContain('insertImmutable(events, event.eventId')
    expect(transcriptSource).toContain('.leftJoin(')
    expect(transcriptSource).toContain('activeLeafEntryId: platformThreads.activeLeafEntryId')
    expect(runDomainJournalSource).toContain('inspectRunDomainProjection(runId: string)')
    expect(runDomainJournalSource).toContain("isolationLevel: 'repeatable read'")
    expect(runDomainJournalSource).toContain('eventRows.map(mapEventRow)')
    expect(platformFacadeSource).toContain('return this.runDomainJournal.inspectRunDomainProjection(runId)')
  })

  it('replays the latest thread projection and keeps deleted threads removed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'geo-threads-'))
    try {
      const harness = new PersistenceFacadeTestHarness()
      const store = harness.create(dir)
      await store.initialize()
      const session = await store.createSession()
      const first = await store.createThread(session.id, '保留线程')
      const deleted = await store.createThread(session.id, '删除线程')
      await store.deleteThread(deleted.id)
      await store.flushConversationStore()

      const restored = harness.create(dir)
      await restored.initialize()

      expect(restored.getSession(session.id).latestThreadId).toBe(first.id)
      expect(restored.listThreadsForSession(session.id).map(thread => thread.id)).toEqual([first.id])
    } finally {
      await removeTempDirectory(dir)
    }
  })

  it('rebuilds derived indexes and pages run summaries without thread fan-out', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'geo-run-index-'))
    try {
      const harness = new PersistenceFacadeTestHarness()
      const store = harness.create(dir)
      await store.initialize()
      const session = await store.createSession()
      const threadIds: string[] = []

      for (let index = 0; index < 28; index += 1) {
        const thread = await store.createThread(session.id, `线程 ${index + 1}`)
        threadIds.push(thread.id)
        await store.createRun(session.id, `查询 ${index + 1}`, { threadId: thread.id })
      }

      const first = store.listRunSummaries({ sessionId: session.id, limit: 20 })
      const second = store.listRunSummaries({ sessionId: session.id, limit: 20, cursor: first.nextCursor })
      expect(first.items).toHaveLength(20)
      expect(first.nextCursor).not.toBeNull()
      expect(second.items).toHaveLength(8)
      expect(new Set([...first.items, ...second.items].map(run => run.id)).size).toBe(28)

      await store.deleteThread(threadIds[0])
      expect(store.listRunSummaries({ sessionId: session.id, limit: 100 }).items).toHaveLength(27)
      await store.flushConversationStore()

      const restored = harness.create(dir)
      await restored.initialize()
      expect(restored.listThreadsForSession(session.id)).toHaveLength(27)
      expect(restored.listRunSummaries({ sessionId: session.id, limit: 100 }).items).toHaveLength(27)
    } finally {
      await removeTempDirectory(dir)
    }
  })
})

async function collectSourceFiles(roots: string[]): Promise<string[]> {
  const files: string[] = []
  for (const root of roots) {
    await collect(root, files)
  }
  return files.filter((file) => /\.(ts|tsx)$/u.test(file))
}

async function removeTempDirectory(directory: string): Promise<void> {
  // Windows 杀毒和文件索引可能短暂持有刚关闭的 JSONL 句柄。
  // 重试只属于测试清理，不改变生产存储或关闭语义。
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 })
}

async function collectProductionFiles(roots: string[]): Promise<string[]> {
  const files: string[] = []
  for (const root of roots) {
    const entry = await stat(root)
    if (entry.isDirectory()) {
      await collect(root, files)
    } else {
      files.push(root)
    }
  }
  return files.filter((file) => {
    const normalized = file.replace(/\\/gu, '/')
    if (normalized.includes('/dist/') || normalized.includes('/node_modules/')) return false
    if (normalized.includes('/original/')) return false
    if (normalized.includes('/__tests__/') || /\.test\.[^.]+$/u.test(normalized)) return false
    return /\.(ts|tsx|py|html|md|json)$/u.test(file)
  })
}

async function collectRepositoryTextFiles(roots: string[]): Promise<string[]> {
  const files: string[] = []
  for (const root of roots) {
    const entry = await stat(root)
    if (entry.isDirectory()) {
      await collect(root, files)
    } else {
      files.push(root)
    }
  }
  return files.filter((file) => {
    const normalized = file.replace(/\\/gu, '/')
    if (
      normalized.includes('/dist/')
      || normalized.includes('/node_modules/')
      || normalized.includes('/original/')
      || normalized.includes('/output/')
      || normalized.includes('/runtime/')
      || normalized.includes('/vendor/')
      || normalized.includes('/.squirrel-vendor/')
    ) {
      return false
    }
    return /\.(?:c?js|example|html|json|md|mjs|ps1|py|service|sh|sql|svg|template|ts|tsx|xml|ya?ml)$/u
      .test(file)
  })
}

async function collect(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (
        entry.name === '.pytest_cache'
        || entry.name === '.squirrel-vendor'
        || entry.name === '__pycache__'
        || entry.name === 'dist'
        || entry.name === 'node_modules'
        || entry.name === 'out'
        || entry.name === 'output'
        || entry.name === 'release'
        || entry.name === 'runtime'
      ) {
        continue
      }
      await collect(fullPath, files)
    } else {
      files.push(fullPath)
    }
  }
}

function item(overrides: Partial<ConversationItem>): ConversationItem {
  return {
    itemId: overrides.itemId ?? `item_${overrides.role ?? overrides.itemType ?? 'entry'}`,
    itemType: overrides.itemType ?? 'message',
    runId: overrides.runId ?? 'run_1',
    threadId: overrides.threadId ?? 'thread_1',
    turnId: null,
    callId: null,
    role: overrides.role ?? 'assistant',
    body: overrides.body ?? null,
    name: null,
    arguments: null,
    output: null,
    isError: false,
    phase: null,
    status: overrides.status ?? 'completed',
    metadata: overrides.metadata ?? {},
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  }
}

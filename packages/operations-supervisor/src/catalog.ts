// +-------------------------------------------------------------------------
//
//   地理智能平台 - 固定服务监督目录
//
//   文件:       catalog.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { OperationsProfile, OperationsServiceId } from '@geo-agent-platform/shared-types/operations'

export interface ExecutableCommand {
  file: string
  args: readonly string[]
}

export type HealthProbe =
  | {
      kind: 'http'
      portEnvironment: string | Record<OperationsProfile, string>
      path: string
      livenessPath: string
      timeoutMs: number
      periodMs: number
      initialDelayMs: number
    }
  | {
      kind: 'exec'
      command: Record<OperationsProfile, { windows: ExecutableCommand; linux: ExecutableCommand }>
      timeoutMs: number
      periodMs: number
      initialDelayMs: number
    }

export interface ServiceDefinition {
  serviceId: OperationsServiceId
  displayName: string
  description: string
  dependencies: readonly OperationsServiceId[]
  command: Record<OperationsProfile, { windows: string; linux: string }>
  health: HealthProbe
  portEnvironments: Record<OperationsProfile, readonly string[]>
  shutdown?: Record<OperationsProfile, { windows: ExecutableCommand; linux: ExecutableCommand }>
}

export const SERVICE_ORDER: readonly OperationsServiceId[] = ['infra', 'worker', 'api']

export const SERVICE_CATALOG: Readonly<Record<OperationsServiceId, ServiceDefinition>> = {
  infra: {
    serviceId: 'infra',
    displayName: '基础设施',
    description: '原生 PostgreSQL/PostGIS 数据库',
    dependencies: [],
    command: {
      development: {
        windows: 'node packages/operations-supervisor/dist/nativeInfrastructure.js',
        linux: 'node packages/operations-supervisor/dist/nativeInfrastructure.js',
      },
      production: {
        windows: 'node packages/operations-supervisor/dist/nativeInfrastructure.js',
        linux: 'node packages/operations-supervisor/dist/nativeInfrastructure.js',
      },
    },
    health: {
      kind: 'exec',
      command: {
        development: {
          windows: { file: 'node', args: ['packages/operations-supervisor/dist/nativeInfrastructure.js', '--check'] },
          linux: { file: 'node', args: ['packages/operations-supervisor/dist/nativeInfrastructure.js', '--check'] },
        },
        production: {
          windows: { file: 'node', args: ['packages/operations-supervisor/dist/nativeInfrastructure.js', '--check'] },
          linux: { file: 'node', args: ['packages/operations-supervisor/dist/nativeInfrastructure.js', '--check'] },
        },
      },
      timeoutMs: 30_000,
      periodMs: 10_000,
      initialDelayMs: 3_000,
    },
    portEnvironments: {
      development: ['POSTGIS_PORT'],
      production: ['POSTGIS_PORT'],
    },
    shutdown: {
      development: {
        windows: { file: 'node', args: ['packages/operations-supervisor/dist/nativeInfrastructure.js', '--stop'] },
        linux: { file: 'node', args: ['packages/operations-supervisor/dist/nativeInfrastructure.js', '--stop'] },
      },
      production: {
        windows: { file: 'node', args: ['packages/operations-supervisor/dist/nativeInfrastructure.js', '--stop'] },
        linux: { file: 'node', args: ['packages/operations-supervisor/dist/nativeInfrastructure.js', '--stop'] },
      },
    },
  },
  worker: {
    serviceId: 'worker',
    displayName: '科学计算',
    description: 'Python 气象与空间计算 Worker',
    dependencies: ['infra'],
    command: {
      development: {
        windows: 'pwsh -NoProfile -File scripts/run-worker.ps1',
        linux: 'bash ./scripts/run-worker.sh',
      },
      production: {
        windows: 'pwsh -NoProfile -File scripts/run-worker.ps1',
        linux: 'bash ./scripts/run-worker.sh',
      },
    },
    health: {
      kind: 'http',
      portEnvironment: 'WORKER_PORT',
      path: '/health',
      livenessPath: '/health/live',
      timeoutMs: 3_000,
      periodMs: 5_000,
      initialDelayMs: 2_000,
    },
    portEnvironments: { development: ['WORKER_PORT'], production: ['WORKER_PORT'] },
  },
  api: {
    serviceId: 'api',
    displayName: '平台 API',
    description: 'Node API、WebSocket 与 Agent Runtime',
    dependencies: ['infra', 'worker'],
    command: {
      development: {
        windows: 'npm run dev:supervised --workspace geo-agent-server',
        linux: 'npm run dev:supervised --workspace geo-agent-server',
      },
      production: {
        windows: 'node apps/server/dist/main.js',
        linux: 'node apps/server/dist/main.js',
      },
    },
    health: {
      kind: 'http',
      portEnvironment: 'API_PORT',
      path: '/health',
      livenessPath: '/health/live',
      timeoutMs: 5_000,
      periodMs: 5_000,
      initialDelayMs: 3_000,
    },
    portEnvironments: { development: ['API_PORT'], production: ['API_PORT'] },
  },
}

export function dependentsOf(serviceId: OperationsServiceId): OperationsServiceId[] {
  return SERVICE_ORDER.filter(candidate => SERVICE_CATALOG[candidate].dependencies.includes(serviceId))
}

export function transitiveDependencies(serviceId: OperationsServiceId): OperationsServiceId[] {
  const result = new Set<OperationsServiceId>()
  const visit = (current: OperationsServiceId): void => {
    for (const dependency of SERVICE_CATALOG[current].dependencies) {
      if (result.has(dependency)) continue
      result.add(dependency)
      visit(dependency)
    }
  }
  visit(serviceId)
  return SERVICE_ORDER.filter(candidate => result.has(candidate))
}

export function transitiveDependents(serviceId: OperationsServiceId): OperationsServiceId[] {
  const result = new Set<OperationsServiceId>()
  const visit = (current: OperationsServiceId): void => {
    for (const dependent of dependentsOf(current)) {
      if (result.has(dependent)) continue
      result.add(dependent)
      visit(dependent)
    }
  }
  visit(serviceId)
  return SERVICE_ORDER.filter(candidate => result.has(candidate))
}

export function commandFor(definition: ServiceDefinition, profile: OperationsProfile): string {
  const platform = process.platform === 'win32' ? 'windows' : 'linux'
  return definition.command[profile][platform]
}

export function executableFor(input: { windows: ExecutableCommand; linux: ExecutableCommand }): ExecutableCommand {
  return process.platform === 'win32' ? input.windows : input.linux
}

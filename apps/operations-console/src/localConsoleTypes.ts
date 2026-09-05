// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本地运维台界面契约
//
//   文件:       localConsoleTypes.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AuditEvent } from '@geo-agent-platform/shared-types/platform'
import type { LocalManagedAccount } from '@geo-agent-platform/shared-types/local-operations'
import type { OperationsClient } from '@geo-agent-platform/operations-supervisor/client'

export type LocalConsoleTab = 'services' | 'logs' | 'accounts' | 'audit'

export interface LocalConsoleDataPlane {
  accounts: {
    listAccounts(): Promise<LocalManagedAccount[]>
    createPlatformAdmin(input: {
      email: string
      password: string
      displayName: string
    }): Promise<LocalManagedAccount>
    grantPlatformAdmin(email: string): Promise<LocalManagedAccount>
    revokePlatformAdmin(email: string): Promise<LocalManagedAccount>
    setAccountEnabled(email: string, enabled: boolean): Promise<LocalManagedAccount>
    resetPassword(email: string, password: string): Promise<void>
    revokeSessions(email: string): Promise<void>
  }
  listAuditEvents: (limit?: number) => Promise<AuditEvent[]>
  close: () => Promise<void>
}

export interface LocalConsoleOptions {
  connectSupervisor: () => Promise<OperationsClient>
  openDataPlane: () => Promise<LocalConsoleDataPlane>
  minPasswordLength: number
}

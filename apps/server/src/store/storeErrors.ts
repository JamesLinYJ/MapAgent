// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久化领域错误
//
//   文件:       storeErrors.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export class StoreNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreNotFoundError'
  }
}

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreConflictError'
  }
}

export class StoreVersionConflictError extends StoreConflictError {
  readonly code = 'version_conflict'

  constructor(
    resource: string,
    expectedRevision: number | null,
    currentRevision: number | null,
  ) {
    super(
      `${resource} 版本冲突：期望 ${expectedRevision ?? '新建'}，`
      + `当前 ${currentRevision ?? '不存在'}`,
    )
    this.name = 'StoreVersionConflictError'
  }
}

export class MemoryVersionConflictError extends StoreConflictError {
  constructor(expectedVersion: number, currentVersion: number) {
    super(`memory 版本冲突：期望 ${expectedVersion}，当前 ${currentVersion}`)
    this.name = 'MemoryVersionConflictError'
  }
}

export class RunDomainSequenceConflictError extends StoreConflictError {
  constructor(runId: string, expectedSequence: number, currentSequence: number) {
    super(
      `run '${runId}' 领域日志 sequence 冲突：`
      + `期望 ${expectedSequence}，当前 ${currentSequence}`,
    )
    this.name = 'RunDomainSequenceConflictError'
  }
}

export class GeoWorldRevisionConflictError extends StoreConflictError {
  constructor(runId: string, expectedRevision: number, currentRevision: number) {
    super(
      `run '${runId}' GeoWorld revision 冲突：`
      + `期望 ${expectedRevision}，当前 ${currentRevision}`,
    )
    this.name = 'GeoWorldRevisionConflictError'
  }
}

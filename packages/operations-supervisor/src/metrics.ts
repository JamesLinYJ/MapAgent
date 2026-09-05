// +-------------------------------------------------------------------------
//
//   地理智能平台 - 主机与原生进程树指标
//
//   文件:       metrics.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import path from 'node:path'

import type {
  OperationsMetric,
  OperationsServiceId,
} from '@geo-agent-platform/shared-types/operations'
import si from 'systeminformation'

export interface ProcessTreeMetrics {
  cpuPercent: OperationsMetric
  memoryBytes: OperationsMetric
}

export async function collectProcessTreeMetrics(
  roots: ReadonlyMap<OperationsServiceId, number | null>,
): Promise<Map<OperationsServiceId, ProcessTreeMetrics>> {
  try {
    const result = await si.processes()
    const byParent = new Map<number, number[]>()
    const byPid = new Map(result.list.map(processInfo => [processInfo.pid, processInfo]))
    for (const processInfo of result.list) {
      const children = byParent.get(processInfo.parentPid) ?? []
      children.push(processInfo.pid)
      byParent.set(processInfo.parentPid, children)
    }
    const output = new Map<OperationsServiceId, ProcessTreeMetrics>()
    for (const [serviceId, rootPid] of roots) {
      if (!rootPid) {
        output.set(serviceId, unavailableProcessMetrics('服务没有运行进程。'))
        continue
      }
      const pids = descendants(rootPid, byParent)
      pids.add(rootPid)
      let cpu = 0
      let memory = 0
      let observed = false
      let cpuComplete = true
      let memoryComplete = true
      for (const pid of pids) {
        const processInfo = byPid.get(pid)
        if (!processInfo) continue
        observed = true
        if (Number.isFinite(processInfo.cpu)) cpu += processInfo.cpu
        else cpuComplete = false
        if (Number.isFinite(processInfo.memRss)) memory += processInfo.memRss * 1024
        else memoryComplete = false
      }
      output.set(serviceId, observed
        ? {
            cpuPercent: cpuComplete ? available(cpu) : unavailable('进程树包含无效 CPU 指标。'),
            memoryBytes: memoryComplete ? available(memory) : unavailable('进程树包含无效内存指标。'),
          }
        : unavailableProcessMetrics('操作系统未返回该进程树。'))
    }
    return output
  } catch (error) {
    const message = `进程指标采集失败：${safeReason(error)}`
    return new Map([...roots.keys()].map(serviceId => [serviceId, unavailableProcessMetrics(message)]))
  }
}

export async function collectHostMetrics(runtimeRoot: string): Promise<{
  cpuPercent: OperationsMetric
  memoryUsedBytes: OperationsMetric
  memoryTotalBytes: OperationsMetric
  runtimeDiskUsedBytes: OperationsMetric
  runtimeDiskTotalBytes: OperationsMetric
}> {
  try {
    const [load, memory, fileSystems] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize()])
    const root = path.parse(runtimeRoot).root.replace(/[\\/]+$/u, '').toLowerCase()
    const fileSystem = fileSystems.find(item => {
      const mount = item.mount.replace(/[\\/]+$/u, '').toLowerCase()
      return mount === root || runtimeRoot.toLowerCase().startsWith(`${mount}${path.sep}`)
    })
    return {
      cpuPercent: available(load.currentLoad),
      memoryUsedBytes: available(Number.isFinite(memory.active) ? memory.active : memory.used),
      memoryTotalBytes: available(memory.total),
      runtimeDiskUsedBytes: fileSystem ? available(fileSystem.used) : unavailable('未找到运行时目录所在磁盘。'),
      runtimeDiskTotalBytes: fileSystem ? available(fileSystem.size) : unavailable('未找到运行时目录所在磁盘。'),
    }
  } catch (error) {
    const reason = `主机指标采集失败：${safeReason(error)}`
    return {
      cpuPercent: unavailable(reason),
      memoryUsedBytes: unavailable(reason),
      memoryTotalBytes: unavailable(reason),
      runtimeDiskUsedBytes: unavailable(reason),
      runtimeDiskTotalBytes: unavailable(reason),
    }
  }
}

export function unavailable(reason: string): OperationsMetric {
  return { value: null, unavailableReason: reason }
}

export function available(value: number): OperationsMetric {
  return Number.isFinite(value) ? { value } : unavailable('指标源返回了非有限数值。')
}

function unavailableProcessMetrics(reason: string): ProcessTreeMetrics {
  return { cpuPercent: unavailable(reason), memoryBytes: unavailable(reason) }
}

function descendants(rootPid: number, byParent: ReadonlyMap<number, readonly number[]>): Set<number> {
  const result = new Set<number>()
  const pending = [...(byParent.get(rootPid) ?? [])]
  while (pending.length) {
    const pid = pending.pop()
    if (pid === undefined || result.has(pid)) continue
    result.add(pid)
    pending.push(...(byParent.get(pid) ?? []))
  }
  return result
}

function safeReason(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 240) : '未知错误。'
}

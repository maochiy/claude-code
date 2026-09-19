/**
 * 旧 Hermes DispatchRun 的只读兼容存储。
 *
 * Local CLI 原生 Tasks、Subagent、Plan 与 Workflow 是新的执行权威。这里仅允许
 * 历史版本写入的任务图继续被查询和审计，不能批准、推进或再次启动模型任务。
 */

import type { DispatchRun } from '@proma/shared'
import { getRuntimeDispatchRunsPath } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'

export interface DispatchStore {
  runs: DispatchRun[]
  updatedAt: number
}

export interface DispatchStoreAdapter {
  read: () => DispatchStore
  write: (store: DispatchStore) => void
}

let storeAdapter: DispatchStoreAdapter | undefined

function defaultStoreAdapter(): DispatchStoreAdapter {
  return {
    read: () => {
      const store = readJsonFileSafe<Partial<DispatchStore>>(getRuntimeDispatchRunsPath())
      return {
        runs: Array.isArray(store?.runs) ? store.runs : [],
        updatedAt: typeof store?.updatedAt === 'number' ? store.updatedAt : 0,
      }
    },
    write: (store) => writeJsonFileAtomic(getRuntimeDispatchRunsPath(), store),
  }
}

export function setDispatchStoreAdapter(adapter: DispatchStoreAdapter | undefined): void {
  storeAdapter = adapter
}

/** 旧导出名仅作读取兼容；历史 Runtime 归属必须原样保留。 */
export function normalizeLegacyDispatchStore(store: DispatchStore): DispatchStore {
  return store
}

/** @deprecated 仅供旧调用方迁移名称兼容。 */
export const migrateDispatchStoreToPi = normalizeLegacyDispatchStore

function readStore(): DispatchStore {
  const adapter = (storeAdapter ??= defaultStoreAdapter())
  return adapter.read()
}

export function listDispatchRuns(sessionId?: string): DispatchRun[] {
  return readStore().runs
    .filter((run) => !sessionId || run.sessionId === sessionId)
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

export function getDispatchRun(runId: string): DispatchRun | null {
  return readStore().runs.find((run) => run.id === runId) || null
}

export function getLatestDispatchRun(sessionId: string): DispatchRun | null {
  return listDispatchRuns(sessionId)[0] || null
}

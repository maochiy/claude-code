/**
 * Agent 会话清空事务。
 *
 * Runtime 原生 Session、Proma 会话索引与 JSONL 投影分属不同文件/进程，无法依赖
 * 单次原子 rename 一起提交。这里用一个很小的 JSON 事务日志记录桌面预留的新原生
 * Session ID；崩溃恢复时重复执行本地 finalize，避免恢复到旧 Session 或重复统计历史。
 */

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { getConfigDir } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'

export type AgentSessionClearPhase = 'preparing' | 'prepared' | 'runtime_cleared'

export interface AgentSessionClearTransaction {
  sessionId: string
  archiveSessionId: string
  intendedRuntimeSessionId: string
  phase: AgentSessionClearPhase
  hasArchive?: boolean
  createdAt: number
  updatedAt: number
}

interface AgentSessionClearTransactionFile {
  version: 1
  transactions: AgentSessionClearTransaction[]
}

function createEmptyFile(): AgentSessionClearTransactionFile {
  return { version: 1, transactions: [] }
}

function isTransaction(value: unknown): value is AgentSessionClearTransaction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.sessionId === 'string'
    && record.sessionId.trim().length > 0
    && typeof record.archiveSessionId === 'string'
    && record.archiveSessionId.trim().length > 0
    && typeof record.intendedRuntimeSessionId === 'string'
    && record.intendedRuntimeSessionId.trim().length > 0
    && (record.phase === 'preparing' || record.phase === 'prepared' || record.phase === 'runtime_cleared')
    && (record.hasArchive === undefined || typeof record.hasArchive === 'boolean')
    && typeof record.createdAt === 'number'
    && Number.isFinite(record.createdAt)
    && typeof record.updatedAt === 'number'
    && Number.isFinite(record.updatedAt)
}

function parseDocument(filePath: string): AgentSessionClearTransactionFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (error) {
    throw new Error(`Agent 会话清空事务日志损坏: ${filePath}`, { cause: error })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Agent 会话清空事务日志格式无效: ${filePath}`)
  }
  const document = parsed as Record<string, unknown>
  if (document.version !== 1) {
    throw new Error(`不支持的 Agent 会话清空事务日志版本: ${String(document.version)}`)
  }
  if (!Array.isArray(document.transactions) || !document.transactions.every(isTransaction)) {
    throw new Error(`Agent 会话清空事务日志包含无效记录: ${filePath}`)
  }
  const transactions = document.transactions as AgentSessionClearTransaction[]
  const sessionIds = new Set(transactions.map((transaction) => transaction.sessionId))
  const archiveSessionIds = new Set(transactions.map((transaction) => transaction.archiveSessionId))
  const runtimeSessionIds = new Set(transactions.map((transaction) => transaction.intendedRuntimeSessionId))
  if (
    sessionIds.size !== transactions.length
    || archiveSessionIds.size !== transactions.length
    || runtimeSessionIds.size !== transactions.length
  ) {
    throw new Error(`Agent 会话清空事务日志包含重复会话: ${filePath}`)
  }
  return { version: 1, transactions }
}

export class AgentSessionClearTransactionStore {
  constructor(
    private readonly filePath?: string,
  ) {}

  private get resolvedFilePath(): string {
    return this.filePath ?? join(getConfigDir(), 'agent-session-clear-transactions.json')
  }

  list(): AgentSessionClearTransaction[] {
    return this.readDocument().transactions
  }

  get(sessionId: string): AgentSessionClearTransaction | undefined {
    return this.list().find((transaction) => transaction.sessionId === sessionId)
  }

  begin(input: {
    sessionId: string
    archiveSessionId: string
    intendedRuntimeSessionId: string
    now?: number
  }): AgentSessionClearTransaction {
    const document = this.readDocument()
    if (document.transactions.some((transaction) => transaction.sessionId === input.sessionId)) {
      throw new Error(`Agent 会话仍有未完成的清空事务: ${input.sessionId}`)
    }
    const now = input.now ?? Date.now()
    const transaction: AgentSessionClearTransaction = {
      sessionId: input.sessionId,
      archiveSessionId: input.archiveSessionId,
      intendedRuntimeSessionId: input.intendedRuntimeSessionId,
      phase: 'preparing',
      createdAt: now,
      updatedAt: now,
    }
    document.transactions.push(transaction)
    this.writeDocument(document)
    return transaction
  }

  markPrepared(sessionId: string, hasArchive: boolean, now = Date.now()): AgentSessionClearTransaction {
    return this.update(sessionId, { phase: 'prepared', hasArchive, updatedAt: now })
  }

  markRuntimeCleared(sessionId: string, now = Date.now()): AgentSessionClearTransaction {
    return this.update(sessionId, { phase: 'runtime_cleared', updatedAt: now })
  }

  /** Runtime preflight 明确拒绝时，先持久化回滚意图再删除临时归档。 */
  markRollbackPending(sessionId: string, now = Date.now()): AgentSessionClearTransaction {
    return this.update(sessionId, { phase: 'preparing', updatedAt: now })
  }

  remove(sessionId: string): void {
    const document = this.readDocument()
    const transactions = document.transactions.filter((transaction) => transaction.sessionId !== sessionId)
    if (transactions.length === document.transactions.length) return
    this.writeDocument({ ...document, transactions })
  }

  private update(
    sessionId: string,
    updates: Partial<Pick<AgentSessionClearTransaction, 'phase' | 'hasArchive' | 'updatedAt'>>,
  ): AgentSessionClearTransaction {
    const document = this.readDocument()
    const index = document.transactions.findIndex((transaction) => transaction.sessionId === sessionId)
    if (index < 0) throw new Error(`Agent 会话清空事务不存在: ${sessionId}`)
    const updated = { ...document.transactions[index]!, ...updates }
    document.transactions[index] = updated
    this.writeDocument(document)
    return updated
  }

  private readDocument(): AgentSessionClearTransactionFile {
    if (!existsSync(this.resolvedFilePath)) return createEmptyFile()
    return parseDocument(this.resolvedFilePath)
  }

  private writeDocument(document: AgentSessionClearTransactionFile): void {
    // 事务日志不能使用通用 .bak 自动恢复：旧 backup 可能包含已经提交并删除的事务，
    // 重放会误清空新上下文。主文件存在时必须严格校验并失败关闭。
    writeJsonFileAtomic(this.resolvedFilePath, document, true)
  }
}

export interface AgentSessionClearRecoveryHandlers {
  rollbackArchive: (transaction: AgentSessionClearTransaction) => void
  persistRuntimeTarget: (transaction: AgentSessionClearTransaction) => void
  clearCurrentProjection: (transaction: AgentSessionClearTransaction) => void
}

/**
 * 重放单个清空事务。所有步骤都必须幂等；只有全部成功后才删除事务日志。
 */
export function recoverAgentSessionClearTransaction(
  store: AgentSessionClearTransactionStore,
  transaction: AgentSessionClearTransaction,
  handlers: AgentSessionClearRecoveryHandlers,
): 'rolled_back' | 'finalized' {
  if (transaction.phase === 'preparing') {
    handlers.rollbackArchive(transaction)
    store.remove(transaction.sessionId)
    return 'rolled_back'
  }

  handlers.persistRuntimeTarget(transaction)
  handlers.clearCurrentProjection(transaction)
  store.remove(transaction.sessionId)
  return 'finalized'
}

/**
 * 清空事务未完成时，用量扫描只能读取一份旧历史：
 * - preparing：Runtime 尚未进入清空阶段，保留 source、排除可能只复制了一部分的 archive；
 * - prepared/runtime_cleared：清空意图已提交，保留 archive、排除尚未截断的 source。
 */
export function resolveAgentSessionIdsExcludedFromUsage(
  transactions: readonly AgentSessionClearTransaction[],
): Set<string> {
  const excluded = new Set<string>()
  for (const transaction of transactions) {
    excluded.add(transaction.phase === 'preparing'
      ? transaction.archiveSessionId
      : transaction.sessionId)
  }
  return excluded
}

export const agentSessionClearTransactionStore = new AgentSessionClearTransactionStore()

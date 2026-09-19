import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  QuickTaskRecoveryKey,
  QuickTaskRecoveryRecord,
  QuickTaskRecoveryStageInput,
} from '../../types'

interface QuickTaskRecoveryFile {
  version: 1
  records: QuickTaskRecoveryRecord[]
}

function isRecoveryRecord(value: unknown): value is QuickTaskRecoveryRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<QuickTaskRecoveryRecord>
  return typeof record.requestId === 'string'
    && typeof record.submissionId === 'string'
    && (record.mode === 'chat' || record.mode === 'agent')
    && typeof record.sessionId === 'string'
    && typeof record.title === 'string'
    && typeof record.message === 'string'
    && (record.status === 'prepared' || record.status === 'accepted')
    && typeof record.createdAt === 'number'
    && typeof record.updatedAt === 'number'
}

/**
 * Main 进程持有的轻量恢复记录。它只保存已经落盘的附件引用，绝不保存 base64 内容。
 */
export class QuickTaskRecoveryStore {
  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  stage(input: QuickTaskRecoveryStageInput): QuickTaskRecoveryRecord {
    const records = this.readAll()
    const previous = records.find(record => record.submissionId === input.submissionId)
    if (previous?.status === 'accepted') {
      throw new Error(`快速任务 ${input.submissionId} 已被接收，不能覆盖恢复记录`)
    }
    const timestamp = this.now()
    const record: QuickTaskRecoveryRecord = {
      ...input,
      status: 'prepared',
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    this.writeAll([
      ...records.filter(item => item.submissionId !== input.submissionId),
      record,
    ])
    return record
  }

  accept(key: Required<QuickTaskRecoveryKey>): QuickTaskRecoveryRecord | undefined {
    const records = this.readAll()
    const index = records.findIndex(record => (
      record.submissionId === key.submissionId && record.requestId === key.requestId
    ))
    if (index < 0) return undefined
    const current = records[index]!
    const accepted: QuickTaskRecoveryRecord = {
      ...current,
      status: 'accepted',
      updatedAt: this.now(),
    }
    records[index] = accepted
    this.writeAll(records)
    return accepted
  }

  listAccepted(): QuickTaskRecoveryRecord[] {
    return this.readAll()
      .filter(record => record.status === 'accepted')
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  hasAccepted(submissionId: string): boolean {
    return this.readAll().some(record => (
      record.submissionId === submissionId && record.status === 'accepted'
    ))
  }

  remove(key: QuickTaskRecoveryKey): boolean {
    const records = this.readAll()
    const remaining = records.filter(record => (
      record.submissionId !== key.submissionId
      || (key.requestId != null && record.requestId !== key.requestId)
    ))
    if (remaining.length === records.length) return false
    this.writeAll(remaining)
    return true
  }

  private readAll(): QuickTaskRecoveryRecord[] {
    if (!existsSync(this.filePath)) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`快速任务恢复记录 JSON 损坏，已保留原文件：${reason}`)
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('快速任务恢复记录格式无效，已保留原文件')
    }
    const file = parsed as Partial<QuickTaskRecoveryFile> & { version?: unknown; records?: unknown }
    if (file.version !== 1) {
      throw new Error(`不支持快速任务恢复记录版本 ${String(file.version)}，已保留原文件`)
    }
    if (!Array.isArray(file.records) || !file.records.every(isRecoveryRecord)) {
      throw new Error('快速任务恢复记录内容无效，已保留原文件')
    }
    return file.records
  }

  private writeAll(records: QuickTaskRecoveryRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    const data: QuickTaskRecoveryFile = { version: 1, records }
    writeFileSync(temporaryPath, JSON.stringify(data, null, 2), 'utf8')
    renameSync(temporaryPath, this.filePath)
  }
}

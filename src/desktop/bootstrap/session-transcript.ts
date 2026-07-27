import { randomUUID, type UUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import type {
  ContentReplacementEntry,
  Entry,
  SerializedMessage,
  TranscriptMessage,
} from '../../types/logs.js'
import { parseJSONL } from '../../utils/json.js'
import {
  getTranscriptPath,
  getTranscriptPathForSession,
  isTranscriptMessage,
} from '../../utils/sessionStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'

interface ForkedTranscriptMessage extends TranscriptMessage {
  forkedFrom?: {
    sessionId: string
    messageUuid: UUID
  }
}

export interface ForkRuntimeTranscriptOptions {
  upToMessageUuid?: string
}

export interface ForkRuntimeTranscriptResult {
  runtimeSessionId: UUID
  transcriptPath: string
  messages: SerializedMessage[]
}

function mainConversationMessages(entries: Entry[]): TranscriptMessage[] {
  return entries.filter(
    (entry): entry is TranscriptMessage =>
      isTranscriptMessage(entry) && !entry.isSidechain,
  )
}

async function atomicWriteTranscript(
  targetPath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, targetPath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

/**
 * 原子创建 Runtime transcript 分叉。
 *
 * Desktop Runtime 与 CLI 共用 CCB transcript 格式，但不会调用 CLI 命令或
 * 解析终端输出。`upToMessageUuid` 为包含式截断点。
 */
export async function forkRuntimeTranscript(
  options: ForkRuntimeTranscriptOptions = {},
): Promise<ForkRuntimeTranscriptResult> {
  const sourceSessionId = getSessionId()
  const sourcePath = getTranscriptPath()
  const content = await readFile(sourcePath, 'utf8').catch(() => '')
  if (!content.trim())
    throw new Error('当前 Runtime Session 没有可分叉的 transcript')

  const entries = parseJSONL<Entry>(Buffer.from(content))
  const sourceMessages = mainConversationMessages(entries)
  if (sourceMessages.length === 0) {
    throw new Error('当前 Runtime Session 没有可分叉的主线消息')
  }

  let selectedMessages = sourceMessages
  if (options.upToMessageUuid) {
    const targetIndex = sourceMessages.findIndex(
      message => message.uuid === options.upToMessageUuid,
    )
    if (targetIndex < 0) {
      throw new Error(
        `Runtime transcript 中未找到消息: ${options.upToMessageUuid}`,
      )
    }
    selectedMessages = sourceMessages.slice(0, targetIndex + 1)
  }

  const runtimeSessionId = randomUUID() as UUID
  const transcriptPath = getTranscriptPathForSession(runtimeSessionId)
  const lines: string[] = []
  const messages: SerializedMessage[] = []
  let parentUuid: UUID | null = null

  for (const source of selectedMessages) {
    const forked: ForkedTranscriptMessage = {
      ...source,
      sessionId: runtimeSessionId,
      parentUuid,
      isSidechain: false,
      forkedFrom: {
        sessionId: sourceSessionId,
        messageUuid: source.uuid,
      },
    }
    const serialized: SerializedMessage = {
      ...source,
      sessionId: runtimeSessionId,
    }
    lines.push(jsonStringify(forked))
    messages.push(serialized)
    if (source.type !== 'progress') parentUuid = source.uuid
  }

  const replacements = entries
    .filter(
      (entry): entry is ContentReplacementEntry =>
        entry.type === 'content-replacement' &&
        entry.sessionId === sourceSessionId,
    )
    .flatMap(entry => entry.replacements)
  if (replacements.length > 0) {
    const replacementEntry: ContentReplacementEntry = {
      type: 'content-replacement',
      sessionId: runtimeSessionId,
      replacements,
    }
    lines.push(jsonStringify(replacementEntry))
  }

  await atomicWriteTranscript(transcriptPath, `${lines.join('\n')}\n`)
  return { runtimeSessionId, transcriptPath, messages }
}

/**
 * 文件历史快照记录在用户消息 UUID 上。给定 UI 选择的 assistant UUID，
 * 返回该 assistant 之前最近的主线 user UUID。
 */
export async function resolveRewindUserMessageUuid(
  assistantMessageUuid: string,
): Promise<UUID> {
  const content = await readFile(getTranscriptPath(), 'utf8').catch(() => '')
  if (!content.trim()) throw new Error('当前 Runtime Session 没有 transcript')
  const messages = mainConversationMessages(
    parseJSONL<Entry>(Buffer.from(content)),
  )
  const assistantIndex = messages.findIndex(
    message => message.uuid === assistantMessageUuid,
  )
  if (assistantIndex < 0) {
    throw new Error(`Runtime transcript 中未找到消息: ${assistantMessageUuid}`)
  }
  for (let index = assistantIndex - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type === 'user') return message.uuid
  }
  throw new Error('目标 assistant 消息之前没有可恢复的 user 消息')
}

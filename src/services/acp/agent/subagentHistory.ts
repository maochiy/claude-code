/** Scoped, bounded history access for AgentTool children over ACP extension methods. */
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message } from '../../../types/message.js'
import {
  buildConversationChain,
  flushSessionStorage,
  loadTranscriptFile,
  MAX_TRANSCRIPT_READ_BYTES,
} from '../../../utils/sessionStorage.js'
import {
  canonicalizePath,
  extractJsonStringField,
  readSessionLite,
  getProjectDir,
  validateUuid,
} from '../../../utils/sessionStoragePortable.js'
import type { AcpSession } from './sessionTypes.js'

const AGENT_ID = /^a[0-9a-f]{16}$/
const MAX_CHILDREN = 1000
const PAGE_SIZE = 100
const MAX_TEXT_LENGTH = 32768

type Child = {
  agentId: string
  parentToolUseId: string
  status?: 'running' | 'success' | 'failed' | 'cancelled'
}
type Owner = { parentSessionId: string; parentToolUseId: string }

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name]
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Invalid ${name}`)
  return value
}

async function scope(
  sessions: Map<string, AcpSession>,
  params: Record<string, unknown>,
) {
  const sessionId = requiredString(params, 'sessionId')
  const cwd = requiredString(params, 'cwd')
  if (!validateUuid(sessionId)) throw new Error('Invalid sessionId')
  const session = sessions.get(sessionId)
  if (
    !session ||
    (await canonicalizePath(cwd)) !== (await canonicalizePath(session.cwd))
  ) {
    throw new Error('Session is not active for cwd')
  }
  // Use the active session's exact project directory. Session files may not
  // exist yet on a fresh ACP turn; resolving through sibling worktrees would
  // expose another workspace's child records before the first transcript write.
  const projectDir = getProjectDir(session.cwd)
  const mainPath = join(projectDir, `${sessionId}.jsonl`)
  try {
    const info = await lstat(mainPath)
    if (!info.isFile()) throw new Error('Session transcript is not a file')
    const lite = await readSessionLite(mainPath)
    const persistedCwd = lite && extractJsonStringField(lite.head, 'cwd')
    if (
      !persistedCwd ||
      (await canonicalizePath(persistedCwd)) !==
        (await canonicalizePath(session.cwd))
    ) {
      throw new Error('Session transcript cwd mismatch')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return {
    session,
    sessionId,
    directory: join(projectDir, sessionId, 'subagents'),
  }
}

async function ownerFor(
  directory: string,
  agentId: string,
  sessionId: string,
): Promise<Owner | null> {
  if (!AGENT_ID.test(agentId)) return null
  const metadataPath = join(directory, `agent-${agentId}.meta.json`)
  try {
    if (!(await lstat(metadataPath)).isFile()) return null
    const raw = await readFile(metadataPath, 'utf8')
    if (raw.length > 16384) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const metadata = parsed as Record<string, unknown>
    if (
      metadata.parentSessionId !== sessionId ||
      typeof metadata.parentToolUseId !== 'string' ||
      !metadata.parentToolUseId
    )
      return null
    return {
      parentSessionId: sessionId,
      parentToolUseId: metadata.parentToolUseId,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function persistedStatus(
  directory: string,
  agentId: string,
): Promise<Child['status']> {
  try {
    const path = join(directory, `agent-${agentId}.status.json`)
    if (!(await lstat(path)).isFile()) return undefined
    const raw = await readFile(path, 'utf8')
    if (raw.length > 256) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return undefined
    const status = (parsed as Record<string, unknown>).status
    return status === 'success' || status === 'failed' || status === 'cancelled'
      ? status
      : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function taskStatus(session: AcpSession, agentId: string): Child['status'] {
  const task = session.appState.tasks[agentId]
  if (!task || task.type !== 'local_agent') return undefined
  switch (task.status) {
    case 'running':
      return 'running'
    case 'completed':
      return 'success'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'cancelled'
    default:
      return undefined
  }
}

export async function listSubagentHistory(
  sessions: Map<string, AcpSession>,
  params: Record<string, unknown>,
): Promise<{ children: Child[] }> {
  const { session, sessionId, directory } = await scope(sessions, params)
  let names: string[]
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter(
        entry =>
          entry.isFile() &&
          /^agent-a[0-9a-f]{16}\.meta\.json$/.test(entry.name),
      )
      .map(entry => entry.name.slice(6, -10))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { children: [] }
    throw error
  }
  if (names.length > MAX_CHILDREN) throw new Error('Too many subagents')
  const children: Child[] = []
  for (const agentId of names) {
    const owner = await ownerFor(directory, agentId, sessionId)
    if (!owner) continue
    const status =
      taskStatus(session, agentId) ??
      (await persistedStatus(directory, agentId))
    children.push({
      agentId,
      parentToolUseId: owner.parentToolUseId,
      ...(status && { status }),
    })
  }
  return { children }
}

type HistoryBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error?: boolean
    }

const SENSITIVE_KEY =
  /password|secret|token|credential|authorization|api[_-]?key/i

function boundedValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[nested value omitted]'
  if (typeof value === 'string') return value.slice(0, 8192)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return value
  if (Array.isArray(value))
    return value.slice(0, 100).map(item => boundedValue(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [
          key,
          SENSITIVE_KEY.test(key)
            ? '[redacted]'
            : boundedValue(item, depth + 1),
        ]),
    )
  }
  return null
}

function toolInput(value: unknown): unknown {
  const bounded = boundedValue(value)
  return JSON.stringify(bounded).length <= MAX_TEXT_LENGTH
    ? bounded
    : { truncated: true }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, MAX_TEXT_LENGTH)
  if (!Array.isArray(value)) return ''
  return value
    .filter(
      (item): item is { type: 'text'; text: string } =>
        item &&
        typeof item === 'object' &&
        item.type === 'text' &&
        typeof item.text === 'string',
    )
    .map(item => item.text)
    .join('\n')
    .slice(0, MAX_TEXT_LENGTH)
}

function historyBlocks(message: Message): HistoryBlock[] {
  if (message.type !== 'assistant' && message.type !== 'user') return []
  const content = message.message?.content
  if (typeof content === 'string')
    return [{ type: 'text', text: content.slice(0, MAX_TEXT_LENGTH) }]
  if (!Array.isArray(content)) return []
  const blocks: HistoryBlock[] = []
  let remaining = MAX_TEXT_LENGTH * 2
  for (const raw of content.slice(0, 50)) {
    if (!raw || typeof raw !== 'object' || remaining <= 0) break
    const block = raw as unknown as Record<string, unknown>
    let result: HistoryBlock | undefined
    if (block.type === 'text' && typeof block.text === 'string') {
      result = {
        type: 'text',
        text: block.text.slice(0, Math.min(MAX_TEXT_LENGTH, remaining)),
      }
    } else if (
      block.type === 'thinking' &&
      typeof block.thinking === 'string'
    ) {
      result = {
        type: 'thinking',
        thinking: block.thinking.slice(0, Math.min(MAX_TEXT_LENGTH, remaining)),
      }
    } else if (
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      result = {
        type: 'tool_use',
        id: block.id.slice(0, 256),
        name: block.name.slice(0, 256),
        input: toolInput(block.input),
      }
    } else if (
      block.type === 'tool_result' &&
      typeof block.tool_use_id === 'string'
    ) {
      result = {
        type: 'tool_result',
        tool_use_id: block.tool_use_id.slice(0, 256),
        content: contentText(block.content).slice(0, remaining),
        ...(typeof block.is_error === 'boolean' && {
          is_error: block.is_error,
        }),
      }
    }
    if (!result) continue
    const size = JSON.stringify(result).length
    if (size > remaining) break
    remaining -= size
    blocks.push(result)
  }
  return blocks
}

function historyText(blocks: HistoryBlock[]): string {
  return blocks
    .filter(
      (block): block is Extract<HistoryBlock, { type: 'text' }> =>
        block.type === 'text',
    )
    .map(block => block.text)
    .join('\n')
    .slice(0, MAX_TEXT_LENGTH)
}

export async function readSubagentHistory(
  sessions: Map<string, AcpSession>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { session, sessionId, directory } = await scope(sessions, params)
  const agentId = requiredString(params, 'agentId')
  if (!AGENT_ID.test(agentId)) throw new Error('Invalid agentId')
  const owner = await ownerFor(directory, agentId, sessionId)
  if (!owner) throw new Error('Subagent not found in session')
  const cursor = params.cursor
  if (cursor !== undefined && cursor !== null && !validateUuid(cursor))
    throw new Error('Invalid cursor')
  await flushSessionStorage()
  const transcriptPath = join(directory, `agent-${agentId}.jsonl`)
  let messages: Message[] = []
  try {
    const info = await lstat(transcriptPath)
    if (!info.isFile() || info.size > MAX_TRANSCRIPT_READ_BYTES)
      throw new Error('Subagent transcript unavailable or too large')
    const result = await loadTranscriptFile(transcriptPath)
    const agentMessages = [...result.messages.values()].filter(
      message => message.agentId === agentId && message.isSidechain,
    )
    const parentUuids = new Set(
      agentMessages.map(message => message.parentUuid),
    )
    const leaf = agentMessages
      .filter(message => !parentUuids.has(message.uuid))
      .sort(
        (left, right) =>
          Date.parse(right.timestamp) - Date.parse(left.timestamp),
      )[0]
    messages = leaf
      ? buildConversationChain(result.messages, leaf)
          .filter(
            message =>
              message.agentId === agentId &&
              (message.type === 'assistant' || message.type === 'user'),
          )
          .map(
            ({
              isSidechain: _isSidechain,
              parentUuid: _parentUuid,
              ...message
            }) => message,
          )
      : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const start =
    cursor == null
      ? 0
      : messages.findIndex(message => message.uuid === cursor) + 1
  if (cursor != null && start === 0) throw new Error('Unknown cursor')
  const page = messages.slice(start, start + PAGE_SIZE)
  const nextCursor =
    start + PAGE_SIZE < messages.length ? page.at(-1)?.uuid : undefined
  const status =
    taskStatus(session, agentId) ?? (await persistedStatus(directory, agentId))
  return {
    agentId,
    parentToolUseId: owner.parentToolUseId,
    messages: page.map(message => {
      const blocks = historyBlocks(message)
      return {
        id: message.uuid,
        role: message.type,
        text: historyText(blocks),
        blocks,
      }
    }),
    ...(nextCursor && { nextCursor }),
    ...(status && { status }),
  }
}

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentMessagePinsSnapshot,
  AgentMessagePinUpdateInput,
  SDKMessage,
} from '@proma/shared'
import { getConfigDir } from './config-paths'
import { getAgentSessionMeta, getAgentSessionSDKMessages } from './agent-session-manager'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

const MESSAGE_PIN_VERSION = 1

interface PersistedMessagePins {
  version: typeof MESSAGE_PIN_VERSION
  messageUuids: string[]
}

interface MessagePinServiceDependencies {
  pinsDirectory?: () => string
  sessionExists?: (sessionId: string) => boolean
  loadMessages?: (sessionId: string) => SDKMessage[]
}

export interface MessagePinService {
  list(sessionId: string): AgentMessagePinsSnapshot
  set(input: AgentMessagePinUpdateInput): AgentMessagePinsSnapshot
}

function normalizeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 无效`)
  const normalized = value.trim()
  if (!normalized || normalized.includes('\0')) {
    throw new Error(`${label} 无效`)
  }
  return normalized
}

function normalizePersistedPins(value: PersistedMessagePins | null): string[] {
  if (!value || value.version !== MESSAGE_PIN_VERSION || !Array.isArray(value.messageUuids)) {
    return []
  }
  return [...new Set(value.messageUuids.filter((uuid): uuid is string => (
    typeof uuid === 'string' && uuid.trim().length > 0
  )).map(uuid => uuid.trim()))]
}

function collectMessageUuids(messages: SDKMessage[]): Set<string> {
  const uuids = new Set<string>()
  for (const message of messages) {
    const uuid = (message as { uuid?: unknown }).uuid
    if (typeof uuid === 'string' && uuid.trim()) uuids.add(uuid.trim())
  }
  return uuids
}

export function createMessagePinService(
  dependencies: MessagePinServiceDependencies = {},
): MessagePinService {
  const pinsDirectory = dependencies.pinsDirectory ?? (() => join(getConfigDir(), 'agent-message-pins'))
  const sessionExists = dependencies.sessionExists ?? ((sessionId) => getAgentSessionMeta(sessionId) != null)
  const loadMessages = dependencies.loadMessages ?? getAgentSessionSDKMessages

  const ensureSession = (sessionId: string): void => {
    if (!sessionExists(sessionId)) {
      throw new Error(`Agent 会话不存在: ${sessionId}`)
    }
  }

  const resolvePath = (sessionId: string): string => {
    const directory = pinsDirectory()
    mkdirSync(directory, { recursive: true })
    return join(directory, `${encodeURIComponent(sessionId)}.json`)
  }

  const read = (sessionId: string): string[] => normalizePersistedPins(
    readJsonFileSafe<PersistedMessagePins>(resolvePath(sessionId)),
  )

  const snapshot = (sessionId: string, messageUuids: string[]): AgentMessagePinsSnapshot => {
    const existing = collectMessageUuids(loadMessages(sessionId))
    return {
      sessionId,
      messageUuids: [...messageUuids],
      missingMessageUuids: messageUuids.filter(uuid => !existing.has(uuid)),
    }
  }

  return {
    list(rawSessionId) {
      const sessionId = normalizeIdentifier(rawSessionId, '会话 ID')
      ensureSession(sessionId)
      return snapshot(sessionId, read(sessionId))
    },

    set(input) {
      if (typeof input?.pinned !== 'boolean') {
        throw new Error('消息置顶状态无效')
      }
      const sessionId = normalizeIdentifier(input.sessionId, '会话 ID')
      const messageUuid = normalizeIdentifier(input.messageUuid, '消息 UUID')
      ensureSession(sessionId)

      const current = read(sessionId)
      const alreadyPinned = current.includes(messageUuid)
      if (input.pinned && !collectMessageUuids(loadMessages(sessionId)).has(messageUuid)) {
        throw new Error(`无法置顶：会话历史中不存在消息 ${messageUuid}`)
      }

      const next = input.pinned
        ? (alreadyPinned ? current : [...current, messageUuid])
        : current.filter(uuid => uuid !== messageUuid)

      if (next.length !== current.length || next.some((uuid, index) => uuid !== current[index])) {
        writeJsonFileAtomic(resolvePath(sessionId), {
          version: MESSAGE_PIN_VERSION,
          messageUuids: next,
        })
      }
      return snapshot(sessionId, next)
    },
  }
}

const defaultMessagePinService = createMessagePinService()

export function listAgentMessagePins(sessionId: string): AgentMessagePinsSnapshot {
  return defaultMessagePinService.list(sessionId)
}

export function setAgentMessagePin(input: AgentMessagePinUpdateInput): AgentMessagePinsSnapshot {
  return defaultMessagePinService.set(input)
}

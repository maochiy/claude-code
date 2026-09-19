import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Pin, X } from 'lucide-react'
import { toast } from 'sonner'
import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@proma/shared'
import {
  agentMessagePinsAtomFamily,
  loadAgentMessagePinsAtom,
  setAgentMessagePinAtom,
} from '@/atoms/message-pins'
import { useTranslation } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { jumpToAgentMessage } from './MessagePinAction'

const PREVIEW_MAX_LENGTH = 88

export interface PinnedMessageEntry {
  messageUuid: string
  role: 'user' | 'assistant' | 'message'
  preview: string
  missing: boolean
}

function normalizePreviewText(value: string): string {
  const withoutInternalMarkup = value
    .replace(/<attached_files>[\s\S]*?<\/attached_files>/gi, ' ')
    .replace(/<quoted_(?:file|context)[^>]*>[\s\S]*?<\/quoted_(?:file|context)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  const normalized = withoutInternalMarkup.replace(/\s+/g, ' ').trim()
  if (normalized.length <= PREVIEW_MAX_LENGTH) return normalized
  return `${normalized.slice(0, PREVIEW_MAX_LENGTH - 1).trimEnd()}…`
}

function extractVisibleMessageText(message: SDKMessage): string {
  if (message.type !== 'user' && message.type !== 'assistant') return ''
  const visibleMessage = message as SDKUserMessage | SDKAssistantMessage
  const content = visibleMessage.message?.content
  if (typeof content === 'string') return normalizePreviewText(content)
  if (!Array.isArray(content)) return ''
  return normalizePreviewText(content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block as { text: string }).text)
    .join(' '))
}

/** 只从用户/助手可见正文生成预览，不展示工具输入、输出或日志。 */
export function buildPinnedMessageEntries(
  messageUuids: string[],
  missingMessageUuids: string[],
  messages: SDKMessage[],
  labels: {
    missing: string
    user: string
    assistant: string
    message: string
  },
): PinnedMessageEntry[] {
  const missing = new Set(missingMessageUuids)
  const byUuid = new Map<string, SDKMessage>()
  for (const message of messages) {
    const uuid = (message as { uuid?: unknown }).uuid
    if (typeof uuid === 'string' && uuid) byUuid.set(uuid, message)
  }

  return messageUuids.map((messageUuid) => {
    const message = byUuid.get(messageUuid)
    const isMissing = missing.has(messageUuid) || !message
    const role = message?.type === 'user'
      ? 'user'
      : message?.type === 'assistant'
        ? 'assistant'
        : 'message'
    const fallback = role === 'user'
      ? labels.user
      : role === 'assistant'
        ? labels.assistant
        : labels.message
    return {
      messageUuid,
      role,
      preview: isMissing ? labels.missing : extractVisibleMessageText(message) || fallback,
      missing: isMissing,
    }
  })
}

export interface PinnedMessagesProps {
  sessionId: string
  messages: SDKMessage[]
}

export function PinnedMessages({ sessionId, messages }: PinnedMessagesProps): React.ReactElement | null {
  const { language } = useTranslation()
  const state = useAtomValue(agentMessagePinsAtomFamily(sessionId))
  const loadPins = useSetAtom(loadAgentMessagePinsAtom)
  const setPin = useSetAtom(setAgentMessagePinAtom)
  const [removing, setRemoving] = React.useState<Set<string>>(() => new Set())
  const lastReportedLoadError = React.useRef<string | undefined>(undefined)
  const text = React.useMemo(() => (language === 'zh'
    ? {
        title: '已置顶',
        missing: '该消息已不在当前历史中',
        user: '用户消息',
        assistant: '助手消息',
        message: '会话消息',
        jumpFailed: '无法定位置顶消息',
        jumpFailedDescription: '该消息可能已从历史中移除。',
        loadFailed: '加载置顶消息失败',
        remove: '取消置顶',
        removeFailed: '取消置顶失败',
      }
    : {
        title: 'Pinned',
        missing: 'This message is no longer in the current history',
        user: 'User message',
        assistant: 'Assistant message',
        message: 'Conversation message',
        jumpFailed: 'Could not find the pinned message',
        jumpFailedDescription: 'It may have been removed from the conversation history.',
        loadFailed: 'Failed to load pinned messages',
        remove: 'Unpin message',
        removeFailed: 'Failed to unpin message',
      }), [language])

  React.useEffect(() => {
    lastReportedLoadError.current = undefined
  }, [sessionId])

  React.useEffect(() => {
    if (state.status !== 'idle') return
    void loadPins({ sessionId }).catch(() => undefined)
  }, [loadPins, sessionId, state.status])

  React.useEffect(() => {
    if (state.status !== 'error' || !state.error) return
    if (lastReportedLoadError.current === state.error) return
    lastReportedLoadError.current = state.error
    toast.error(text.loadFailed)
  }, [state.error, state.status, text.loadFailed])

  const entries = React.useMemo(() => buildPinnedMessageEntries(
    state.messageUuids,
    state.missingMessageUuids,
    messages,
    text,
  ), [messages, state.messageUuids, state.missingMessageUuids, text])

  const handleJump = (entry: PinnedMessageEntry): void => {
    if (!entry.missing && jumpToAgentMessage(entry.messageUuid)) return
    toast.warning(text.jumpFailed, { description: text.jumpFailedDescription })
  }

  const handleRemove = async (messageUuid: string): Promise<void> => {
    if (removing.has(messageUuid)) return
    setRemoving((current) => new Set(current).add(messageUuid))
    try {
      await setPin({ sessionId, messageUuid, pinned: false })
    } catch {
      toast.error(text.removeFailed)
    } finally {
      setRemoving((current) => {
        const next = new Set(current)
        next.delete(messageUuid)
        return next
      })
    }
  }

  if (entries.length === 0) return null

  return (
    <div
      className="flex shrink-0 items-center gap-2 bg-muted/25 px-4 py-1.5 text-xs"
      data-agent-pinned-messages
    >
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground" aria-label={text.title}>
        <Pin className="size-3" />
        <span>{text.title}</span>
      </span>
      <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {entries.map((entry) => (
          <div
            key={entry.messageUuid}
            className={cn(
              'flex max-w-[min(420px,70vw)] shrink-0 items-center rounded-md bg-background/80 shadow-sm ring-1 ring-border/50',
              entry.missing && 'text-muted-foreground',
            )}
            data-pinned-message={entry.missing ? 'missing' : entry.role}
          >
            <button
              type="button"
              className="min-w-0 truncate px-2 py-1 text-left hover:text-foreground"
              onClick={() => handleJump(entry)}
            >
              {entry.preview}
            </button>
            <button
              type="button"
              className="mr-0.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              title={text.remove}
              aria-label={text.remove}
              disabled={removing.has(entry.messageUuid)}
              onClick={() => { void handleRemove(entry.messageUuid) }}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

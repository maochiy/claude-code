import { createHash } from 'node:crypto'
import type {
  ChatToolActivity,
  ChatRuntimeUsageSnapshot,
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
  SDKResultMessage,
  SDKToolResultBlock,
  SDKUserMessage,
} from '@proma/shared'
import type { LocalCliAgentQueryOptions, LocalCliMessageContent } from './query-options'

export interface LocalChatHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LocalChatImage {
  mediaType: string
  data: string
}

/**
 * Chat 不重启原生会话也要在下一轮读取最新的全局自定义指令。
 * 因此把设置快照随本轮用户输入发送，而不是只依赖进程启动时的 system prompt。
 */
export function buildLocalChatCurrentMessage(
  currentMessage: string,
  customInstructions?: string,
): string {
  const instructions = customInstructions?.trim()
  if (!instructions) return currentMessage
  return [
    '<global_custom_instructions>',
    instructions,
    '</global_custom_instructions>',
    '<current_user_message>',
    currentMessage,
    '</current_user_message>',
  ].join('\n')
}

export interface LocalChatSessionEvent {
  type: 'text' | 'reasoning' | 'tool_activity'
  delta?: string
  activity?: ChatToolActivity
}

export interface LocalChatSessionResult {
  content: string
  reasoning: string
  toolActivities: ChatToolActivity[]
  model?: string
  runtimeSessionId: string
  runtimeUsage?: ChatRuntimeUsageSnapshot
}

export interface LocalChatRuntimeRunner {
  query(input: LocalCliAgentQueryOptions): AsyncIterable<SDKMessage>
  abort(sessionId: string): Promise<void>
  dispose?(): void | Promise<void>
}

export interface RunLocalChatSessionInput {
  conversationId: string
  history: LocalChatHistoryMessage[]
  resumeSessionId?: string
  options: LocalCliAgentQueryOptions
  onEvent: (event: LocalChatSessionEvent) => void
}

interface ToolState {
  name: string
  input: Record<string, unknown>
}

const CHAT_SESSION_NAMESPACE = 'bd0b7f74-f634-4d2f-814d-fd4ce0ad1e11'

function uuidBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll('-', ''), 'hex')
}

/**
 * CLI 的 `--session-id` 只接受 UUID。使用独立 v5 namespace 从 Chat 对话 ID
 * 稳定派生，既能跨重启复用，也不会和同名 Agent Session 共用原生 transcript。
 */
export function chatRuntimeSessionId(conversationId: string): string {
  const digest = createHash('sha1')
    .update(uuidBytes(CHAT_SESSION_NAMESPACE))
    .update(conversationId)
    .digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function numberRecord(value: unknown): Record<string, number | undefined> {
  const result: Record<string, number | undefined> = {}
  for (const [key, candidate] of Object.entries(readRecord(value))) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) result[key] = candidate
  }
  return result
}

function modelUsageRecord(value: unknown): Record<string, Record<string, number | undefined>> | undefined {
  const models: Record<string, Record<string, number | undefined>> = {}
  for (const [modelId, candidate] of Object.entries(readRecord(value))) {
    const usage = numberRecord(candidate)
    if (Object.keys(usage).length > 0) models[modelId] = usage
  }
  return Object.keys(models).length > 0 ? models : undefined
}

function runtimeUsageSnapshot(
  message: SDKResultMessage,
  fallbackSessionId: string,
): ChatRuntimeUsageSnapshot {
  const record = message as SDKResultMessage & Record<string, unknown>
  const nativeSessionId = typeof record.session_id === 'string' && record.session_id
    ? record.session_id
    : fallbackSessionId
  const processGeneration = typeof record._runtimeGeneration === 'string'
    ? record._runtimeGeneration
    : typeof record._runtimeGeneration === 'number'
      ? String(record._runtimeGeneration)
      : undefined
  const eventId = typeof record.uuid === 'string' && record.uuid
    ? record.uuid
    : typeof record.eventId === 'string' && record.eventId
      ? record.eventId
      : typeof record._runtimeRunId === 'string' && record._runtimeRunId
        ? record._runtimeRunId
        : typeof record._runtimeSequence === 'number'
          ? `${nativeSessionId}:${processGeneration ?? 'legacy'}:${record._runtimeSequence}`
          : undefined
  const createdAt = typeof record._createdAt === 'number' ? record._createdAt : Date.now()
  const durationMs = typeof record.duration_ms === 'number'
    ? record.duration_ms
    : typeof record.durationMs === 'number' ? record.durationMs : 0
  const modelCalls = typeof record.num_turns === 'number'
    ? record.num_turns
    : typeof record.modelCalls === 'number' ? record.modelCalls : undefined
  const modelUsage = modelUsageRecord(record.modelUsage)
  return {
    nativeSessionId,
    ...(processGeneration ? { processGeneration } : {}),
    ...(eventId ? { eventId } : {}),
    createdAt,
    durationMs,
    ...(modelCalls !== undefined ? { modelCalls } : {}),
    usage: numberRecord(message.usage),
    ...(modelUsage ? { modelUsage } : {}),
  }
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        const record = readRecord(item)
        return typeof record.text === 'string' ? record.text : ''
      })
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }
  if (content === undefined) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function chatToolDisplayName(runtimeName: string): string {
  if (runtimeName === 'mcp__web_search__WebSearch') return 'web_search'
  if (runtimeName === 'mcp__web_search__WebFetch') return 'web_fetch'
  if (runtimeName === 'mcp__nano_banana__generate_image') return 'generate_image'
  const chatTool = /^mcp__chat_tools__(.+)$/.exec(runtimeName)
  return chatTool?.[1] ?? runtimeName
}

function snapshotDelta(previous: string | undefined, next: string): string {
  if (!previous) return next
  if (next === previous) return ''
  if (next.startsWith(previous)) return next.slice(previous.length)
  return next
}

function messageId(message: SDKMessage): string {
  const record = message as Record<string, unknown>
  const inner = readRecord(record.message)
  if (typeof inner.id === 'string' && inner.id) return inner.id
  if (typeof record.uuid === 'string' && record.uuid) return record.uuid
  return 'assistant'
}

function blockIndexes(message: SDKMessage, count: number): number[] {
  const record = message as Record<string, unknown>
  if (Array.isArray(record._partialBlockIndexes)) {
    const indexes = record._partialBlockIndexes.filter((value): value is number => typeof value === 'number')
    if (indexes.length === count) return indexes
  }
  if (typeof record._partialBlockIndex === 'number' && count === 1) {
    return [record._partialBlockIndex]
  }
  return Array.from({ length: count }, (_, index) => index)
}

function withPromptText(
  content: LocalCliMessageContent | undefined,
  prompt: string,
): LocalCliMessageContent | undefined {
  if (!Array.isArray(content)) return content
  let replaced = false
  const blocks = content.map((block) => {
    if (replaced || block === null || typeof block !== 'object' || Array.isArray(block)) return block
    if (block.type !== 'text') return block
    replaced = true
    return { ...block, text: prompt }
  })
  return replaced ? blocks : [{ type: 'text', text: prompt }, ...blocks]
}

/** 构造 CLI 原生多模态 user content，base64 不添加 data URL 前缀。 */
export function buildLocalChatMessageContent(
  text: string,
  images: LocalChatImage[],
): LocalCliMessageContent | undefined {
  if (images.length === 0) return undefined
  return [
    { type: 'text', text },
    ...images.map(image => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType,
        data: image.data,
      },
    })),
  ]
}

/**
 * 旧 Chat 没有保存 CLI 原生 Session ID。首次迁移时把 JSONL 历史明确交给
 * Runtime；后续轮次依赖同一个 Local Service Session，不重复注入历史。
 */
export function buildLocalChatPrompt(
  history: LocalChatHistoryMessage[],
  currentMessage: string,
): string {
  if (history.length === 0) return currentMessage
  const transcript = history
    .filter(message => message.content.trim().length > 0)
    .map(message => JSON.stringify({ role: message.role, content: message.content }))
    .join('\n')
  if (!transcript) return currentMessage
  return [
    '<conversation_history>',
    transcript,
    '</conversation_history>',
    '以上是迁移前已发生的对话历史。请延续该上下文，只回答下面的新消息，不要复述历史。',
    '<current_user_message>',
    currentMessage,
    '</current_user_message>',
  ].join('\n')
}

/** 将 Local CLI 的 SDKMessage 流投影回旧 Chat Renderer 使用的增量事件。 */
export class LocalChatSession {
  private readonly initializedConversations = new Set<string>()
  private readonly activeConversations = new Set<string>()

  constructor(private readonly runner: LocalChatRuntimeRunner) {}

  runtimeSessionId(conversationId: string): string {
    return chatRuntimeSessionId(conversationId)
  }

  async run(input: RunLocalChatSessionInput): Promise<LocalChatSessionResult> {
    if (this.activeConversations.has(input.conversationId)) {
      throw new Error('同一对话已有正在执行的请求')
    }
    this.activeConversations.add(input.conversationId)

    const firstRun = !input.resumeSessionId && !this.initializedConversations.has(input.conversationId)
    this.initializedConversations.add(input.conversationId)
    const options: LocalCliAgentQueryOptions = {
      ...input.options,
      sessionId: this.runtimeSessionId(input.conversationId),
      resumeSessionId: input.resumeSessionId,
      prompt: firstRun
        ? buildLocalChatPrompt(input.history, input.options.prompt)
        : input.options.prompt,
    }
    if (firstRun && options.messageContent) {
      options.messageContent = withPromptText(options.messageContent, options.prompt)
    }
    const snapshots = new Map<string, string>()
    const tools = new Map<string, ToolState>()
    const startedTools = new Set<string>()
    const finishedTools = new Set<string>()
    const toolActivities: ChatToolActivity[] = []
    let content = ''
    let reasoning = ''
    let resolvedModel = options.model
    let receivedRuntimeMessage = false
    let nativeSessionId = input.resumeSessionId || options.sessionId
    let terminalUsage: ChatRuntimeUsageSnapshot | undefined

    try {
      for await (const message of this.runner.query(options)) {
        receivedRuntimeMessage = true
        const messageRecord = message as SDKMessage & { session_id?: string }
        if (messageRecord.session_id) nativeSessionId = messageRecord.session_id
        if (message.type === 'assistant') {
          const assistant = message as SDKAssistantMessage
          const blocks = assistant.message.content ?? []
          const indexes = blockIndexes(message, blocks.length)
          const id = messageId(message)
          resolvedModel = assistant.message.model || resolvedModel
          for (let index = 0; index < blocks.length; index++) {
            const block = blocks[index] as SDKContentBlock
            const blockIndex = indexes[index] ?? index
            const key = `${id}:${block.type}:${blockIndex}`
            if (block.type === 'text' && typeof block.text === 'string') {
              const delta = snapshotDelta(snapshots.get(key), block.text)
              snapshots.set(key, block.text)
              if (delta) {
                content += delta
                input.onEvent({ type: 'text', delta })
              }
              continue
            }
            if (block.type === 'thinking' && typeof block.thinking === 'string') {
              const delta = snapshotDelta(snapshots.get(key), block.thinking)
              snapshots.set(key, block.thinking)
              if (delta) {
                reasoning += delta
                input.onEvent({ type: 'reasoning', delta })
              }
              continue
            }
            if (block.type === 'tool_use') {
              const tool = block as { id: string; name: string; input?: unknown }
              const toolInput = readRecord(tool.input)
              const displayName = chatToolDisplayName(tool.name)
              tools.set(tool.id, { name: displayName, input: toolInput })
              if (!startedTools.has(tool.id)) {
                startedTools.add(tool.id)
                const activity: ChatToolActivity = {
                  type: 'start',
                  toolCallId: tool.id,
                  toolName: displayName,
                  input: toolInput,
                }
                toolActivities.push(activity)
                input.onEvent({ type: 'tool_activity', activity })
              }
            }
          }
          continue
        }

        if (message.type === 'user') {
          const user = message as SDKUserMessage
          for (const block of user.message?.content ?? []) {
            if (block.type !== 'tool_result') continue
            const result = block as SDKToolResultBlock
            if (finishedTools.has(result.tool_use_id)) continue
            finishedTools.add(result.tool_use_id)
            const tool = tools.get(result.tool_use_id)
            const activity: ChatToolActivity = {
              type: 'result',
              toolCallId: result.tool_use_id,
              toolName: tool?.name ?? 'tool',
              input: tool?.input,
              result: stringifyToolResult(result.content),
              isError: result.is_error === true,
            }
            toolActivities.push(activity)
            input.onEvent({ type: 'tool_activity', activity })
          }
          continue
        }

        if (message.type === 'result') {
          const result = message as SDKResultMessage
          terminalUsage = runtimeUsageSnapshot(result, nativeSessionId)
          if (result.subtype !== 'success' && result.isSyntheticCompactionResult !== true) {
            throw new Error(result.errors?.filter(Boolean).join('\n') || '本地 CLI 执行失败')
          }
        }
      }
      return {
        content,
        reasoning,
        toolActivities,
        model: resolvedModel,
        runtimeSessionId: nativeSessionId,
        ...(terminalUsage ? { runtimeUsage: terminalUsage } : {}),
      }
    } catch (error) {
      if (firstRun && !receivedRuntimeMessage) {
        this.initializedConversations.delete(input.conversationId)
      }
      throw error
    } finally {
      this.activeConversations.delete(input.conversationId)
    }
  }

  async stop(conversationId: string): Promise<void> {
    await this.runner.abort(this.runtimeSessionId(conversationId))
  }

  async dispose(): Promise<void> {
    await this.runner.dispose?.()
  }
}

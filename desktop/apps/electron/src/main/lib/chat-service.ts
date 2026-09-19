/**
 * Chat 的 Electron 编排层。
 *
 * Provider 路由、模型执行、工具调用与压缩统一交给 Local Service + CLI；
 * 本层只保留 Chat JSONL、附件文本提取和既有 Renderer 事件投影。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { CHAT_IPC_CHANNELS } from '@proma/shared'
import type {
  ChatMessage,
  ChatRuntimeUsageSnapshot,
  ChatSendInput,
  ChatToolActivity,
  FileAttachment,
  GenerateTitleInput,
} from '@proma/shared'
import { listChannels } from './channel-manager'
import { appendMessage, getConversationMessages, listConversations, updateConversationMeta } from './conversation-manager'
import { extractTextFromAttachment, isDocumentAttachment } from './document-parser'
import { isImageAttachment, readAttachmentAsBase64 } from './attachment-service'
import { materializeChatTools } from './chat-tools/chat-tool-mcp'
import { createFallbackTitle } from './title-generation'
import {
  buildLocalChatCurrentMessage,
  buildLocalChatMessageContent,
  LocalChatSession,
} from './local-service/chat-session'
import { buildLocalCliProviderConfiguration } from './local-service/provider-configuration'
import { LocalCliRuntimeAdapter } from './local-service/runtime-adapter'
import { resolvePromaRuntimeModelRoute } from './runtime/proma-runtime-model-gateway'
import { EXECUTABLE_RUNTIME_ID } from './runtime/executable-runtime-policy'
import { getSettings } from './settings-service'

const activeControllers = new Map<string, AbortController>()
const localChatSession = new LocalChatSession(new LocalCliRuntimeAdapter())
const CHAT_RUNTIME_CWD = join(tmpdir(), 'proma-chat-runtime')

function ensureChatRuntimeCwd(): string {
  mkdirSync(CHAT_RUNTIME_CWD, { recursive: true })
  return CHAT_RUNTIME_CWD
}

function buildImageMessageContent(
  text: string,
  attachments?: FileAttachment[],
): ReturnType<typeof buildLocalChatMessageContent> {
  const images = attachments?.filter(attachment => isImageAttachment(attachment.mediaType)) ?? []
  return buildLocalChatMessageContent(text, images.map(attachment => ({
    mediaType: attachment.mediaType,
    data: readAttachmentAsBase64(attachment.localPath),
  })))
}

async function enrichMessageWithDocuments(
  messageText: string,
  attachments?: FileAttachment[],
): Promise<string> {
  if (!attachments || attachments.length === 0) return messageText
  const docAttachments = attachments.filter(attachment => isDocumentAttachment(attachment.mediaType))
  if (docAttachments.length === 0) return messageText

  const parts = [messageText]
  for (const attachment of docAttachments) {
    try {
      const text = await extractTextFromAttachment(attachment.localPath)
      parts.push(`\n<file name="${attachment.filename}">\n${text.trim() || '[文件内容为空]'}\n</file>`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      console.warn(`[聊天服务] 文档提取失败: ${attachment.filename}`, error)
      parts.push(`\n<file name="${attachment.filename}">\n[文件内容提取失败: ${message}]\n</file>`)
    }
  }
  return parts.join('')
}

async function enrichHistoryWithDocuments(history: ChatMessage[]): Promise<ChatMessage[]> {
  const enriched: ChatMessage[] = []
  for (const message of history) {
    if (message.role === 'user' && message.attachments?.some(attachment => isDocumentAttachment(attachment.mediaType))) {
      enriched.push({
        ...message,
        content: await enrichMessageWithDocuments(message.content, message.attachments),
      })
    } else {
      enriched.push(message)
    }
  }
  return enriched
}

/** 分隔线过滤优先，其次按用户轮次裁剪。 */
function filterHistory(
  messageHistory: ChatMessage[],
  contextDividers?: string[],
  contextLength?: number | 'infinite',
): ChatMessage[] {
  let filtered = messageHistory.filter(
    message => !(message.role === 'assistant' && !message.content.trim()),
  )
  if (contextDividers && contextDividers.length > 0) {
    const dividerIndex = filtered.findIndex(
      message => message.id === contextDividers[contextDividers.length - 1],
    )
    if (dividerIndex >= 0) filtered = filtered.slice(dividerIndex + 1)
  }
  if (typeof contextLength !== 'number' || contextLength < 0) return filtered
  if (contextLength === 0) return []

  const collected: ChatMessage[] = []
  let rounds = 0
  for (let index = filtered.length - 1; index >= 0; index--) {
    const message = filtered[index]
    if (!message) continue
    collected.unshift(message)
    if (message.role === 'user' && ++rounds >= contextLength) break
  }
  return collected
}

function persistAssistantMessage(input: {
  conversationId: string
  modelId: string
  content: string
  reasoning: string
  toolActivities: ChatToolActivity[]
  attachments?: FileAttachment[]
  stopped?: boolean
  error?: string
  runtimeUsage?: ChatRuntimeUsageSnapshot
}): string | undefined {
  if (
    !input.content.trim()
    && !input.error
    && !input.attachments?.length
    && !input.runtimeUsage
  ) return undefined
  const id = randomUUID()
  appendMessage(input.conversationId, {
    id,
    role: 'assistant',
    content: input.content,
    createdAt: Date.now(),
    model: input.modelId,
    reasoning: input.reasoning || undefined,
    toolActivities: input.toolActivities.length > 0 ? input.toolActivities : undefined,
    attachments: input.attachments?.length ? input.attachments : undefined,
    stopped: input.stopped,
    error: input.error,
    runtimeUsage: input.runtimeUsage,
  })
  try {
    updateConversationMeta(input.conversationId, {})
  } catch {
    // 索引更新时间失败不应丢弃已经落盘的消息。
  }
  return id
}

function generatedAttachmentsFromTools(activities: ChatToolActivity[]): FileAttachment[] {
  const attachments: FileAttachment[] = []
  const seen = new Set<string>()
  const marker = /\[PROMA_IMAGE_ATTACHMENT:(\{[^\]]+\})\]/g
  for (const activity of activities) {
    if (activity.type !== 'result' || !activity.result) continue
    for (const match of activity.result.matchAll(marker)) {
      try {
        const value = JSON.parse(match[1] ?? '') as Record<string, unknown>
        if (
          typeof value.localPath !== 'string'
          || typeof value.filename !== 'string'
          || typeof value.mediaType !== 'string'
          || seen.has(value.localPath)
        ) continue
        seen.add(value.localPath)
        attachments.push({
          id: value.localPath,
          localPath: value.localPath,
          filename: value.filename,
          mediaType: value.mediaType,
          size: 0,
        })
      } catch {
        // 非法 marker 只作为普通工具文本保留。
      }
    }
  }
  return attachments
}

export async function sendMessage(
  input: ChatSendInput,
  webContents: WebContents,
): Promise<void> {
  const {
    conversationId,
    userMessage,
    channelId,
    modelId,
    systemMessage,
    contextLength,
    contextDividers,
    attachments,
    thinkingEnabled,
    enabledToolIds,
  } = input

  if (activeControllers.has(conversationId)) {
    webContents.send(CHAT_IPC_CHANNELS.STREAM_ERROR, {
      conversationId,
      error: '同一对话已有正在执行的请求',
    })
    return
  }

  const channel = listChannels().find(candidate => candidate.id === channelId)
  if (!channel) {
    webContents.send(CHAT_IPC_CHANNELS.STREAM_ERROR, { conversationId, error: '渠道不存在' })
    return
  }

  const fullHistory = getConversationMessages(conversationId)
  const conversationMeta = listConversations().find(conversation => conversation.id === conversationId)
  appendMessage(conversationId, {
    id: randomUUID(),
    role: 'user',
    content: userMessage,
    createdAt: Date.now(),
    attachments: attachments?.length ? attachments : undefined,
  })

  const filteredHistory = filterHistory(fullHistory, contextDividers, contextLength)
  const enrichedHistory = await enrichHistoryWithDocuments(filteredHistory)
  const enrichedUserMessage = await enrichMessageWithDocuments(userMessage, attachments)
  const controller = new AbortController()
  activeControllers.set(conversationId, controller)

  let accumulatedContent = ''
  let accumulatedReasoning = ''
  const accumulatedToolActivities: ChatToolActivity[] = []

  try {
    const gateway = await resolvePromaRuntimeModelRoute({
      channelId,
      modelId,
      runtimeId: EXECUTABLE_RUNTIME_ID,
    })
    if (!gateway) throw new Error('当前渠道无法通过本地 CLI 执行')

    const providerConfiguration = buildLocalCliProviderConfiguration(gateway.channel, gateway.route.modelId)
    const cwd = ensureChatRuntimeCwd()
    const runtimeSessionId = localChatSession.runtimeSessionId(conversationId)
    const chatTools = await materializeChatTools({
      runtimeSessionId,
      conversationId,
      cwd,
      enabledToolIds,
    })
    const allowedTools = chatTools.allowedTools
    const allowedToolSet = new Set(allowedTools)
    const runtimeUserMessage = buildLocalChatCurrentMessage(
      enrichedUserMessage,
      getSettings().customInstructions,
    )
    const effectiveSystemMessage = [systemMessage, chatTools.systemPromptAppend]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n') || undefined
    const result = await localChatSession.run({
      conversationId,
      resumeSessionId: conversationMeta?.runtimeSessionId,
      history: enrichedHistory
        .filter((message): message is ChatMessage & { role: 'user' | 'assistant' } => (
          message.role === 'user' || message.role === 'assistant'
        ))
        .map(message => ({ role: message.role, content: message.content })),
      options: {
        sessionId: '',
        prompt: runtimeUserMessage,
        messageContent: buildImageMessageContent(runtimeUserMessage, attachments),
        cwd,
        channelId,
        model: gateway.route.modelId,
        modelRoute: gateway.route,
        providerConfiguration,
        env: gateway.environment,
        systemPrompt: effectiveSystemMessage,
        thinkingConfig: thinkingEnabled ? { type: 'adaptive' } : { type: 'disabled' },
        sdkPermissionMode: 'default',
        toolPolicy: { allowedTools },
        availableBuiltinTools: [],
        strictMcpConfig: true,
        mcpServers: chatTools.mcpServers,
        canUseTool: async (toolName, toolInput) => allowedToolSet.has(toolName)
          ? { behavior: 'allow', updatedInput: toolInput }
          : { behavior: 'deny', message: `Chat 模式未启用工具：${toolName}` },
        abortSignal: controller.signal,
        compactRequest: enrichedUserMessage.trim() === '/compact',
        onSessionId: (nativeSessionId) => {
          if (nativeSessionId !== conversationMeta?.runtimeSessionId) {
            updateConversationMeta(conversationId, { runtimeSessionId: nativeSessionId })
          }
        },
      },
      onEvent: (event) => {
        if (event.type === 'text' && event.delta) {
          accumulatedContent += event.delta
          webContents.send(CHAT_IPC_CHANNELS.STREAM_CHUNK, { conversationId, delta: event.delta })
        } else if (event.type === 'reasoning' && event.delta) {
          accumulatedReasoning += event.delta
          webContents.send(CHAT_IPC_CHANNELS.STREAM_REASONING, { conversationId, delta: event.delta })
        } else if (event.type === 'tool_activity' && event.activity) {
          accumulatedToolActivities.push(event.activity)
          webContents.send(CHAT_IPC_CHANNELS.STREAM_TOOL_ACTIVITY, {
            conversationId,
            activity: event.activity,
          })
        }
      },
    })

    accumulatedContent ||= result.content
    accumulatedReasoning ||= result.reasoning
    if (result.runtimeSessionId !== conversationMeta?.runtimeSessionId) {
      updateConversationMeta(conversationId, { runtimeSessionId: result.runtimeSessionId })
    }
    if (accumulatedToolActivities.length === 0) accumulatedToolActivities.push(...result.toolActivities)
    if (controller.signal.aborted) {
      const messageId = persistAssistantMessage({
        conversationId,
        modelId: result.model || gateway.route.modelId,
        content: accumulatedContent,
        reasoning: accumulatedReasoning,
        toolActivities: accumulatedToolActivities,
        attachments: generatedAttachmentsFromTools(accumulatedToolActivities),
        stopped: true,
        runtimeUsage: result.runtimeUsage,
      })
      webContents.send(CHAT_IPC_CHANNELS.STREAM_COMPLETE, {
        conversationId,
        model: result.model || gateway.route.modelId,
        messageId,
      })
      return
    }
    const messageId = persistAssistantMessage({
      conversationId,
      modelId: result.model || gateway.route.modelId,
      content: accumulatedContent,
      reasoning: accumulatedReasoning,
      toolActivities: accumulatedToolActivities,
      attachments: generatedAttachmentsFromTools(accumulatedToolActivities),
      runtimeUsage: result.runtimeUsage,
    })
    webContents.send(CHAT_IPC_CHANNELS.STREAM_COMPLETE, {
      conversationId,
      model: result.model || gateway.route.modelId,
      messageId,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      const messageId = persistAssistantMessage({
        conversationId,
        modelId,
        content: accumulatedContent,
        reasoning: accumulatedReasoning,
        toolActivities: accumulatedToolActivities,
        attachments: generatedAttachmentsFromTools(accumulatedToolActivities),
        stopped: true,
      })
      webContents.send(CHAT_IPC_CHANNELS.STREAM_COMPLETE, { conversationId, model: modelId, messageId })
      return
    }

    const errorMessage = error instanceof Error ? error.message : '未知错误'
    console.error('[聊天服务] 本地 CLI 执行失败:', error)
    persistAssistantMessage({
      conversationId,
      modelId,
      content: accumulatedContent,
      reasoning: accumulatedReasoning,
      toolActivities: accumulatedToolActivities,
      attachments: generatedAttachmentsFromTools(accumulatedToolActivities),
      stopped: true,
      error: errorMessage,
    })
    webContents.send(CHAT_IPC_CHANNELS.STREAM_ERROR, { conversationId, error: errorMessage })
  } finally {
    activeControllers.delete(conversationId)
  }
}

export function stopGeneration(conversationId: string): void {
  const controller = activeControllers.get(conversationId)
  if (!controller) return
  controller.abort()
  console.log(`[聊天服务] 已请求本地 CLI 中止对话: ${conversationId}`)
}

export function stopAllGenerations(): void {
  if (activeControllers.size === 0) return
  console.log(`[聊天服务] 正在中止所有活跃对话 (${activeControllers.size} 个)...`)
  for (const controller of activeControllers.values()) controller.abort()
  activeControllers.clear()
}

/** 标题不再旁路直连 Provider，使用稳定的本地标题投影。 */
export async function generateTitle(input: GenerateTitleInput): Promise<string | null> {
  return createFallbackTitle(input.userMessage)
}

/**
 * 个人用量服务
 *
 * 扫描本地 Agent 与 Chat JSONL，汇总 Token / 连续天数 / 常用模型。
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { listChannels } from './channel-manager'
import { listConversations } from './conversation-manager'
import { listAgentSessions } from './agent-session-manager'
import {
  getAgentSessionMessagesPath,
  getAgentSessionsIndexPath,
  getConversationMessagesPath,
  getConversationsIndexPath,
} from './config-paths'
import {
  aggregateUserUsage,
  createEmptyUserUsageSummary,
  isUsageRelatedLine,
  parseUsageRecords,
  selectSessionQueries,
  type UsageQuery,
  type UsageMessageEvent,
  type UsageSessionSpan,
  type UsageSkillUse,
} from './user-usage-aggregator'
import {
  agentSessionClearTransactionStore,
  resolveAgentSessionIdsExcludedFromUsage,
} from './agent-session-clear-transaction'
import type { UserUsageCollectionState, UserUsageSummary } from '../../types'

interface UsageCache {
  key: string
  summary: UserUsageSummary
}

let cache: UsageCache | null = null

export function resolveAgentUsageCoverage(input: {
  totalSessions: number
  sessionsWithUsage: number
  failedSessions: number
}): UserUsageCollectionState {
  if (input.totalSessions <= 0 || input.sessionsWithUsage <= 0) return 'unavailable'
  if (input.failedSessions > 0 || input.sessionsWithUsage < input.totalSessions) return 'partial'
  return 'complete'
}

function fileStamp(filePath: string): string {
  if (!existsSync(filePath)) return 'missing'
  try {
    const stat = statSync(filePath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'error'
  }
}

function cacheKey(sessionIds: string[], conversationIds: string[]): string {
  const messageStamps = sessionIds
    .map((sessionId) => `${sessionId}:${fileStamp(getAgentSessionMessagesPath(sessionId))}`)
    .join('|')
  const chatMessageStamps = conversationIds
    .map((conversationId) => `${conversationId}:${fileStamp(getConversationMessagesPath(conversationId))}`)
    .join('|')
  return `${fileStamp(getAgentSessionsIndexPath())}|${fileStamp(getConversationsIndexPath())}|${messageStamps}|${chatMessageStamps}`
}

function buildModelNameMap(): Map<string, string> {
  const names = new Map<string, string>()
  for (const channel of listChannels()) {
    for (const model of channel.models || []) {
      if (!model.id) continue
      names.set(model.id, model.name || model.id)
    }
  }
  return names
}

async function readUsageRelatedLines(filePath: string): Promise<string[]> {
  if (!existsSync(filePath)) return []
  const lines: string[] = []
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of reader) {
    if (line && isUsageRelatedLine(line)) lines.push(line)
  }
  return lines
}

export async function getUserUsageSummary(now: Date = new Date()): Promise<UserUsageSummary> {
  try {
    const excludedSessionIds = resolveAgentSessionIdsExcludedFromUsage(
      agentSessionClearTransactionStore.list(),
    )
    const sessions = listAgentSessions().filter(
      (session) => !session.draft && !excludedSessionIds.has(session.id),
    )
    const conversations = listConversations()
    const key = cacheKey(
      sessions.map((session) => session.id),
      conversations.map((conversation) => conversation.id),
    )
    if (cache && cache.key === key && (now.getTime() - cache.summary.checkedAt) < 15_000) {
      return cache.summary
    }
    const modelNames = buildModelNameMap()
    const queries: UsageQuery[] = []
    const skillUses: UsageSkillUse[] = []
    const messageEvents: UsageMessageEvent[] = []
    let failedAgentSessions = 0
    let agentSessionsWithUsage = 0
    let failedChatSessions = 0
    let chatSessionsWithUsage = 0
    const sessionSpans: UsageSessionSpan[] = sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }))

    for (const session of sessions) {
      const filePath = getAgentSessionMessagesPath(session.id)
      try {
        const lines = await readUsageRelatedLines(filePath)
        const records = parseUsageRecords(lines, session.id)
        if (records.invalidLines > 0) failedAgentSessions += 1
        const selected = selectSessionQueries(records)
        if (selected.length > 0) agentSessionsWithUsage += 1
        queries.push(...selected)
        skillUses.push(...records.skillUses)
        messageEvents.push(...records.messageEvents)
      } catch (error) {
        failedAgentSessions += 1
        console.error(`[个人用量] 读取会话失败 (${session.id}):`, error)
      }
    }

    for (const conversation of conversations) {
      try {
        const lines = await readUsageRelatedLines(getConversationMessagesPath(conversation.id))
        const records = parseUsageRecords(lines, conversation.id, 'cowork')
        if (records.invalidLines > 0) failedChatSessions += 1
        const selected = selectSessionQueries(records)
        if (selected.length > 0) chatSessionsWithUsage += 1
        queries.push(...selected)
        messageEvents.push(...records.messageEvents)
      } catch (error) {
        failedChatSessions += 1
        console.error(`[个人用量] 读取 Chat 对话失败 (${conversation.id}):`, error)
      }
    }

    const summary = aggregateUserUsage({
      queries,
      skillUses,
      sessions: sessionSpans,
      chats: conversations.map((conversation) => ({
        id: conversation.id,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      })),
      messageEvents,
      chatCount: conversations.length,
      now,
      resolveModelName: (modelId) => modelNames.get(modelId) || modelId,
    })

    const result: UserUsageSummary = {
      ...summary,
      coverage: {
        code: resolveAgentUsageCoverage({
          totalSessions: sessions.length,
          sessionsWithUsage: agentSessionsWithUsage,
          failedSessions: failedAgentSessions,
        }),
        cowork: resolveAgentUsageCoverage({
          totalSessions: conversations.length,
          sessionsWithUsage: chatSessionsWithUsage,
          failedSessions: failedChatSessions,
        }),
        failedAgentSessions,
        totalAgentSessions: sessions.length,
      },
    }

    cache = { key, summary: result }
    return result
  } catch (error) {
    console.error('[个人用量] 汇总失败:', error)
    return createEmptyUserUsageSummary(now)
  }
}

export function invalidateUserUsageSummaryCache(): void {
  cache = null
}

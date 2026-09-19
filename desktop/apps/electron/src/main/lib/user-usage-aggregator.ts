/**
 * 个人用量汇总纯函数
 *
 * 从 Agent JSONL / Chat 元数据提取 Token、连续天数、常用模型等统计。
 * 不读写磁盘，便于单测。
 */

import type {
  UserUsageDay,
  UserUsageModel,
  UserUsageSkill,
  UserUsageStats,
  UserUsageSummary,
} from '../../types'
import {
  normalizeDiscreteUsageSnapshots,
  normalizeUsageSnapshots,
  type UsageCumulativeSnapshot,
  type UsageDiscreteSnapshot,
  type UsageTokenSnapshot,
} from './user-usage-ledger'

/** 一次模型请求（优先 SDK result，必要时回退 assistant usage） */
export interface UsageQuery {
  sessionId: string
  /** 请求来源；历史 Agent 记录统一属于 Code */
  mode?: 'cowork' | 'code'
  /** result/legacy 属于主调用；auto 是不计入 result 的 classifier side query。 */
  source?: 'result' | 'legacy' | 'auto'
  createdAt: number
  durationMs: number
  fastMode: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** 一条 result 对应的用户轮次数，通常为 1。 */
  turns?: number
  /** Runtime 明确上报的内部模型调用数；旧记录缺失时不设置。 */
  modelCalls?: number
  models: UsageQueryModel[]
}

export interface UsageQueryModel {
  modelId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface UsageSkillUse {
  name: string
  createdAt: number
}

export interface UsageSessionSpan {
  id: string
  createdAt: number
  updatedAt: number
}

export interface UsageMessageEvent {
  sessionId: string
  eventId?: string
  mode?: 'cowork' | 'code'
  createdAt: number
}

export interface AggregateUserUsageInput {
  queries: UsageQuery[]
  skillUses: UsageSkillUse[]
  sessions: UsageSessionSpan[]
  chats?: UsageSessionSpan[]
  messageEvents?: UsageMessageEvent[]
  chatCount: number
  now?: Date
  resolveModelName?: (modelId: string) => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asFiniteNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function asPositiveNumber(value: unknown): number {
  const parsed = asFiniteNumber(value)
  return parsed > 0 ? parsed : 0
}

export function sumUsageTokens(parts: {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}): number {
  return (
    (parts.inputTokens ?? 0)
    + (parts.outputTokens ?? 0)
    + (parts.cacheReadTokens ?? 0)
    + (parts.cacheCreationTokens ?? 0)
  )
}

export function localDayKey(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function parseDayKey(value: string): Date | null {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

export function createEmptyUserUsageSummary(now: Date = new Date()): UserUsageSummary {
  return {
    checkedAt: now.getTime(),
    stats: {
      totalTokens: 0,
      peakDayTokens: 0,
      peakDay: '',
      longestChatDurationMs: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      requests: 0,
      autoTokens: 0,
      autoRequests: 0,
      userMessages: 0,
      turns: 0,
      modelCalls: 0,
      chatCount: 0,
      agentSessionCount: 0,
      fastModeRate: 0,
      skillsExplored: 0,
      skillUses: 0,
    },
    days: [],
    models: [],
    skills: [],
    coverage: {
      code: 'unavailable',
      cowork: 'unavailable',
      failedAgentSessions: 0,
      totalAgentSessions: 0,
    },
  }
}

export function computeStreaks(
  activeDays: Iterable<string>,
  today: Date = new Date(),
): { currentStreakDays: number; longestStreakDays: number } {
  const unique = new Set(Array.from(activeDays).filter((day) => parseDayKey(day)))
  const sorted = Array.from(unique).sort()
  let longest = 0
  let run = 0
  let previous: Date | null = null
  for (const key of sorted) {
    const date = parseDayKey(key)
    if (!date) continue
    if (previous && (date.getTime() - previous.getTime()) === 86_400_000) {
      run += 1
    } else {
      run = 1
    }
    if (run > longest) longest = run
    previous = date
  }

  const todayKey = localDayKey(today)
  let current = 0
  if (unique.has(todayKey)) {
    const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    while (unique.has(localDayKey(cursor))) {
      current += 1
      cursor.setDate(cursor.getDate() - 1)
    }
  }

  return { currentStreakDays: current, longestStreakDays: longest }
}

function looksLikeResultLine(line: string): boolean {
  return line.includes('"type":"result"') || line.includes('"type": "result"')
    || line.includes('"runtimeUsage":') || line.includes('"runtimeUsage": ')
}

function looksLikeSkillLine(line: string): boolean {
  return line.includes('"name":"Skill"') || line.includes('"name": "Skill"')
}

function looksLikeLegacyAssistantLine(line: string): boolean {
  return line.includes('"role":"assistant"') || line.includes('"role": "assistant"')
}

function looksLikeUserLine(line: string): boolean {
  return line.includes('"type":"user"') || line.includes('"type": "user"')
    || line.includes('"role":"user"') || line.includes('"role": "user"')
}

function looksLikeAutoClassifierLine(line: string): boolean {
  return line.includes('"subtype":"auto_mode_classifier"')
    || line.includes('"subtype": "auto_mode_classifier"')
}

export function isUsageRelatedLine(line: string): boolean {
  return looksLikeResultLine(line) || looksLikeSkillLine(line)
    || looksLikeLegacyAssistantLine(line) || looksLikeUserLine(line)
    || looksLikeAutoClassifierLine(line)
}

function optionalPositiveNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    if (!(key in record)) continue
    const parsed = Number(record[key])
    if (Number.isFinite(parsed)) return Math.max(0, parsed)
  }
  return undefined
}

function readTokenSnapshot(value: unknown): UsageTokenSnapshot {
  if (!isRecord(value)) return {}
  const inputTokens = optionalPositiveNumber(value, ['input_tokens', 'inputTokens'])
  const outputTokens = optionalPositiveNumber(value, ['output_tokens', 'outputTokens'])
  const cacheReadTokens = optionalPositiveNumber(
    value,
    ['cache_read_input_tokens', 'cacheReadInputTokens', 'cacheReadTokens'],
  )
  const cacheCreationTokens = optionalPositiveNumber(
    value,
    ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cacheCreationTokens'],
  )
  const totalTokens = optionalPositiveNumber(value, ['total_tokens', 'totalTokens'])
  if (
    inputTokens === undefined
    && outputTokens === undefined
    && cacheReadTokens === undefined
    && cacheCreationTokens === undefined
    && totalTokens !== undefined
  ) {
    // 部分 classifier 版本只暴露 total_tokens；归到 input 保留准确总量与去重语义。
    return { inputTokens: totalTokens }
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  }
}

function readTokenBag(value: unknown): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
} {
  const snapshot = readTokenSnapshot(value)
  return {
    inputTokens: snapshot.inputTokens ?? 0,
    outputTokens: snapshot.outputTokens ?? 0,
    cacheReadTokens: snapshot.cacheReadTokens ?? 0,
    cacheCreationTokens: snapshot.cacheCreationTokens ?? 0,
  }
}

function isFastMode(value: unknown): boolean {
  if (value == null || value === false) return false
  const normalized = String(value).trim().toLowerCase()
  return normalized !== '' && normalized !== 'off' && normalized !== 'false' && normalized !== 'none' && normalized !== '0'
}

function createdAtOf(record: Record<string, unknown>, fallback = 0): number {
  const direct = asPositiveNumber(record._createdAt ?? record.createdAt)
  if (direct > 0) return direct
  return fallback
}

function extractSkillName(input: unknown): string {
  if (typeof input === 'string' && input.trim()) return input.trim()
  if (!isRecord(input)) return ''
  const raw = input.skill ?? input.name ?? input.skill_name ?? input.skillName
  return typeof raw === 'string' ? raw.trim() : ''
}

function extractSkillUses(record: Record<string, unknown>, createdAt: number): UsageSkillUse[] {
  const message = isRecord(record.message) ? record.message : record
  const content = message.content
  if (!Array.isArray(content)) return []
  const uses: UsageSkillUse[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type !== 'tool_use') continue
    if (String(block.name || '') !== 'Skill') continue
    const name = extractSkillName(block.input)
    if (!name) continue
    uses.push({ name, createdAt })
  }
  return uses
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function cumulativeSnapshotFromResult(
  record: Record<string, unknown>,
  sessionId: string,
): UsageCumulativeSnapshot | null {
  if (record.type !== 'result') return null
  if (record.isSyntheticCompactionResult === true) return null
  const models: Record<string, UsageTokenSnapshot> = {}
  if (isRecord(record.modelUsage)) {
    for (const [modelId, modelUsage] of Object.entries(record.modelUsage)) {
      if (!modelId) continue
      const snapshot = readTokenSnapshot(modelUsage)
      if (Object.keys(snapshot).length > 0) models[modelId] = snapshot
    }
  }
  return {
    sessionId,
    nativeSessionId: stringField(record, ['session_id', 'runtimeSessionId', 'nativeSessionId']),
    processGeneration: stringField(record, [
      '_promaProcessGeneration',
      '_runtimeGeneration',
      'processGeneration',
      'process_generation',
      'runtimeProcessGeneration',
    ]),
    eventId: stringField(record, ['uuid', 'eventId', 'event_id']),
    createdAt: createdAtOf(record),
    durationMs: asPositiveNumber(record.duration_ms ?? record.durationMs ?? record._durationMs),
    fastMode: isFastMode(record.fast_mode_state ?? record.fastMode),
    modelCalls: optionalPositiveNumber(record, ['num_turns', 'numTurns', 'model_calls', 'modelCalls']),
    usage: readTokenSnapshot(record.usage),
    models,
  }
}

function discreteSnapshotFromAutoClassifier(
  record: Record<string, unknown>,
  sessionId: string,
): UsageDiscreteSnapshot | null {
  if (record.type !== 'system' || record.subtype !== 'auto_mode_classifier') return null
  if (record.status === 'checking') return null
  if (record.usage_scope !== 'classifier_call' || record.usage_included_in_result !== false) return null
  const callId = stringField(record, ['call_id', 'callId'])
  if (!callId) return null
  const usage = readTokenSnapshot(record.usage)
  if (Object.keys(usage).length === 0) return null
  return {
    sessionId,
    callId,
    createdAt: createdAtOf(record),
    durationMs: asPositiveNumber(record.duration_ms ?? record.durationMs),
    source: 'auto',
    modelId: stringField(record, ['model', 'model_id', 'modelId']) ?? 'unknown',
    usage,
  }
}

function queryFromDelta(
  delta: ReturnType<typeof normalizeUsageSnapshots>[number],
  fallbackModelId: string,
  mode: 'cowork' | 'code',
): UsageQuery {
  const models = delta.models.length > 0
    ? delta.models
    : [{ modelId: fallbackModelId, ...delta.usage }]
  return {
    sessionId: delta.sessionId,
    mode,
    source: 'result',
    createdAt: delta.createdAt,
    durationMs: delta.durationMs,
    fastMode: delta.fastMode,
    ...delta.usage,
    turns: delta.turns,
    ...(delta.modelCalls !== undefined ? { modelCalls: delta.modelCalls } : {}),
    models,
  }
}

function queryFromLegacyAssistant(
  record: Record<string, unknown>,
  sessionId: string,
  mode: 'cowork' | 'code',
): UsageQuery | null {
  if (record.role !== 'assistant') return null
  if (!isRecord(record.usage)) return null
  const usage = readTokenBag(record.usage)
  if (sumUsageTokens(usage) <= 0 && asPositiveNumber(record.usage.costUsd) <= 0) return null
  const modelId = String(record.model || record._channelModelId || '').trim() || 'unknown'
  return {
    sessionId,
    mode,
    source: 'legacy',
    createdAt: createdAtOf(record),
    durationMs: asPositiveNumber(record.durationMs ?? record.duration_ms),
    fastMode: false,
    ...usage,
    turns: 1,
    modelCalls: 1,
    models: [{ modelId, ...usage }],
  }
}

function userMessageFromRecord(
  record: Record<string, unknown>,
  sessionId: string,
  mode: 'cowork' | 'code',
): UsageMessageEvent | null {
  const isUser = record.type === 'user' || record.role === 'user'
  if (!isUser || record.isSynthetic === true || record.parent_tool_use_id) return null
  const message = isRecord(record.message) ? record.message : record
  const content = message.content
  if (Array.isArray(content)) {
    const meaningful = content.filter((block) => !isRecord(block) || block.type !== 'tool_result')
    if (meaningful.length === 0) return null
    const isCompactControl = meaningful.some((block) => isRecord(block)
      && block.type === 'text' && String(block.text || '').trim() === '/compact')
    if (isCompactControl) return null
  }
  const eventId = stringField(record, ['uuid', 'eventId', 'event_id', 'id'])
  return {
    sessionId,
    ...(eventId ? { eventId } : {}),
    mode,
    createdAt: createdAtOf(record),
  }
}

export interface ParsedUsageRecords {
  queries: UsageQuery[]
  fallbackQueries: UsageQuery[]
  skillUses: UsageSkillUse[]
  messageEvents: UsageMessageEvent[]
  invalidLines: number
}

/**
 * 从会话 JSONL 行提取用量。result 优先；无 result 时回退旧版 assistant.usage。
 */
export function parseUsageRecords(
  lines: Iterable<string>,
  sessionId: string,
  mode: 'cowork' | 'code' = 'code',
): ParsedUsageRecords {
  const queries: UsageQuery[] = []
  const fallbackQueries: UsageQuery[] = []
  const skillUses: UsageSkillUse[] = []
  const messageEvents: UsageMessageEvent[] = []
  const cumulativeSnapshots: UsageCumulativeSnapshot[] = []
  const discreteSnapshots: UsageDiscreteSnapshot[] = []
  const fallbackModelIds = new Map<string, string>()
  const seenUserEventIds = new Set<string>()
  let invalidLines = 0

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const maybeResult = looksLikeResultLine(line)
    const maybeSkill = looksLikeSkillLine(line)
    const maybeLegacy = looksLikeLegacyAssistantLine(line)
    const maybeUser = looksLikeUserLine(line)
    const maybeAutoClassifier = looksLikeAutoClassifierLine(line)
    if (!maybeResult && !maybeSkill && !maybeLegacy && !maybeUser && !maybeAutoClassifier) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      invalidLines += 1
      continue
    }
    if (!isRecord(parsed)) {
      invalidLines += 1
      continue
    }

    const runtimeUsage = isRecord(parsed.runtimeUsage) ? parsed.runtimeUsage : undefined
    if (maybeAutoClassifier) {
      const snapshot = discreteSnapshotFromAutoClassifier(parsed, sessionId)
      if (snapshot) discreteSnapshots.push(snapshot)
    }
    if (maybeResult) {
      const usageRecord = runtimeUsage
        ? { ...runtimeUsage, type: 'result', _channelModelId: parsed.model }
        : parsed
      const snapshot = cumulativeSnapshotFromResult(usageRecord, sessionId)
      if (snapshot) {
        cumulativeSnapshots.push(snapshot)
        if (snapshot.eventId) {
          fallbackModelIds.set(
            snapshot.eventId,
            String(usageRecord._channelModelId || usageRecord.model || '').trim() || 'unknown',
          )
        }
      }
    } else if (maybeLegacy) {
      const query = queryFromLegacyAssistant(parsed, sessionId, mode)
      if (query) fallbackQueries.push(query)
    }

    if (maybeUser) {
      const message = userMessageFromRecord(parsed, sessionId, mode)
      if (message && (!message.eventId || !seenUserEventIds.has(message.eventId))) {
        if (message.eventId) seenUserEventIds.add(message.eventId)
        messageEvents.push(message)
      }
    }

    if (maybeSkill) {
      skillUses.push(...extractSkillUses(parsed, createdAtOf(parsed)))
    }
  }

  const deltas = normalizeUsageSnapshots(cumulativeSnapshots)
  for (const delta of deltas) {
    queries.push(queryFromDelta(
      delta,
      delta.eventId ? fallbackModelIds.get(delta.eventId) ?? 'unknown' : 'unknown',
      mode,
    ))
  }
  for (const delta of normalizeDiscreteUsageSnapshots(discreteSnapshots)) {
    queries.push({
      sessionId: delta.sessionId,
      mode,
      source: delta.source,
      createdAt: delta.createdAt,
      durationMs: delta.durationMs,
      fastMode: false,
      ...delta.usage,
      turns: delta.turns,
      modelCalls: delta.modelCalls,
      models: delta.models,
    })
  }
  queries.sort((left, right) => left.createdAt - right.createdAt)

  return { queries, fallbackQueries, skillUses, messageEvents, invalidLines }
}

export function selectSessionQueries(records: ParsedUsageRecords): UsageQuery[] {
  const resultQueries = records.queries.filter((query) => query.source !== 'auto')
  const autoQueries = records.queries.filter((query) => query.source === 'auto')
  if (resultQueries.length === 0) {
    return [...records.fallbackQueries, ...autoQueries].sort((a, b) => a.createdAt - b.createdAt)
  }
  const firstResultAt = Math.min(...resultQueries.map((query) => query.createdAt).filter((value) => value > 0))
  if (!Number.isFinite(firstResultAt)) return records.queries
  // 兼容从旧 assistant usage 迁移到 result 的会话：只保留首条 result 之前可定位的旧记录。
  return [
    ...records.fallbackQueries.filter((query) => query.createdAt > 0 && query.createdAt < firstResultAt),
    ...records.queries,
  ].sort((a, b) => a.createdAt - b.createdAt)
}

function longestSessionDurationMs(queries: UsageQuery[], sessions: UsageSessionSpan[]): number {
  const bounds = new Map<string, { min: number; max: number; durationMs: number }>()
  for (const query of queries) {
    if (!query.sessionId) continue
    const createdAt = query.createdAt > 0 ? query.createdAt : 0
    const current = bounds.get(query.sessionId)
    if (!current) {
      bounds.set(query.sessionId, {
        min: createdAt || Number.POSITIVE_INFINITY,
        max: createdAt,
        durationMs: query.durationMs,
      })
      continue
    }
    if (createdAt > 0 && createdAt < current.min) current.min = createdAt
    if (createdAt > current.max) current.max = createdAt
    current.durationMs += query.durationMs
  }

  let longest = 0
  for (const [sessionId, span] of bounds) {
    const wallClock = Number.isFinite(span.min) && span.max > span.min ? span.max - span.min : 0
    const generation = span.durationMs
    const sessionMeta = sessions.find((item) => item.id === sessionId)
    const metaSpan = sessionMeta && sessionMeta.updatedAt > sessionMeta.createdAt
      ? sessionMeta.updatedAt - sessionMeta.createdAt
      : 0
    // 优先用会话内活动跨度；没有时间戳时退回单次请求 duration 合计。
    const candidate = Math.max(wallClock, generation > 0 && wallClock === 0 ? generation : 0, wallClock === 0 ? metaSpan : 0)
    if (candidate > longest) longest = candidate
  }
  return longest
}

export function aggregateUserUsage(input: AggregateUserUsageInput): UserUsageSummary {
  const now = input.now ?? new Date()
  const resolveModelName = input.resolveModelName ?? ((modelId: string) => modelId)
  const queries = input.queries
  const byDay = new Map<string, UserUsageDay>()
  const byModel = new Map<string, UserUsageModel>()
  let totalTokens = 0
  let fastModeCount = 0
  let fastModeEligibleCount = 0
  let autoTokens = 0
  let autoRequests = 0
  let turns = 0
  let modelCalls = 0
  let hasModelCallData = false

  const ensureDay = (day: string): UserUsageDay => {
    const existing = byDay.get(day)
    if (existing) return existing
    const created: UserUsageDay = {
      day,
      tokens: 0,
      requests: 0,
      coworkTokens: 0,
      codeTokens: 0,
      coworkRequests: 0,
      codeRequests: 0,
    }
    byDay.set(day, created)
    return created
  }

  for (const query of queries) {
    const tokens = sumUsageTokens(query)
    totalTokens += tokens
    if (query.source !== 'auto') {
      fastModeEligibleCount += 1
      if (query.fastMode) fastModeCount += 1
    } else {
      autoTokens += tokens
      autoRequests += 1
    }
    const queryTurns = query.turns ?? 1
    turns += queryTurns
    if (query.modelCalls !== undefined) {
      modelCalls += query.modelCalls
      hasModelCallData = true
    }
    const createdAt = query.createdAt > 0 ? query.createdAt : 0
    const day = createdAt > 0 ? localDayKey(createdAt) : ''
    if (day) {
      const dayRow = ensureDay(day)
      dayRow.tokens += tokens
      dayRow.requests += 1
      dayRow.turns = (dayRow.turns ?? 0) + queryTurns
      if (query.modelCalls !== undefined) {
        dayRow.modelCalls = (dayRow.modelCalls ?? 0) + query.modelCalls
      }
      if (query.mode === 'cowork') {
        dayRow.coworkTokens += tokens
        dayRow.coworkRequests += 1
      } else {
        dayRow.codeTokens += tokens
        dayRow.codeRequests += 1
      }
      if (query.source === 'auto') {
        dayRow.autoTokens = (dayRow.autoTokens ?? 0) + tokens
        dayRow.autoRequests = (dayRow.autoRequests ?? 0) + 1
      }
      byDay.set(day, dayRow)
    }

    for (const model of query.models) {
      const modelId = model.modelId || 'unknown'
      const modelTokens = sumUsageTokens(model)
      const current = byModel.get(modelId) || {
        modelId,
        modelName: resolveModelName(modelId) || modelId,
        requests: 0,
        tokens: 0,
        lastUsedAt: 0,
        days: [],
      }
      current.requests += 1
      current.tokens += modelTokens
      if (query.source === 'auto') {
        current.autoTokens = (current.autoTokens ?? 0) + modelTokens
        current.autoRequests = (current.autoRequests ?? 0) + 1
      }
      if (createdAt > current.lastUsedAt) current.lastUsedAt = createdAt
      if (day) {
        const modelDay = current.days?.find((item) => item.day === day)
        if (modelDay) {
          modelDay.tokens += modelTokens
          modelDay.requests += 1
        } else {
          current.days = [...(current.days ?? []), { day, tokens: modelTokens, requests: 1 }]
        }
      }
      if (!current.modelName || current.modelName === modelId) {
        current.modelName = resolveModelName(modelId) || modelId
      }
      byModel.set(modelId, current)
    }
  }

  for (const message of input.messageEvents ?? []) {
    if (message.createdAt <= 0) continue
    const day = localDayKey(message.createdAt)
    if (!day) continue
    const row = ensureDay(day)
    row.userMessages = (row.userMessages ?? 0) + 1
  }

  for (const session of input.sessions) {
    const day = session.createdAt > 0 ? localDayKey(session.createdAt) : ''
    if (!day) continue
    const row = ensureDay(day)
    row.agentSessions = (row.agentSessions ?? 0) + 1
  }
  for (const conversation of input.chats ?? []) {
    const day = conversation.createdAt > 0 ? localDayKey(conversation.createdAt) : ''
    if (!day) continue
    const row = ensureDay(day)
    row.chatSessions = (row.chatSessions ?? 0) + 1
  }

  const days = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day))
  const peakDay = days.reduce<UserUsageDay>(
    (peak, row) => (row.tokens > peak.tokens ? row : peak),
    {
      day: '',
      tokens: 0,
      requests: 0,
      coworkTokens: 0,
      codeTokens: 0,
      coworkRequests: 0,
      codeRequests: 0,
    },
  )
  const streaks = computeStreaks(days.filter((row) => row.tokens > 0 || row.requests > 0).map((row) => row.day), now)

  const skillMap = new Map<string, UserUsageSkill>()
  for (const skill of input.skillUses) {
    const name = skill.name.trim()
    if (!name) continue
    const current = skillMap.get(name) || { name, uses: 0, lastUsedAt: 0 }
    current.uses += 1
    if (skill.createdAt > current.lastUsedAt) current.lastUsedAt = skill.createdAt
    skillMap.set(name, current)
  }
  const skills = Array.from(skillMap.values()).sort((a, b) => b.uses - a.uses || b.lastUsedAt - a.lastUsedAt)

  const stats: UserUsageStats = {
    totalTokens,
    peakDayTokens: peakDay.tokens,
    peakDay: peakDay.day,
    longestChatDurationMs: longestSessionDurationMs(queries, input.sessions),
    currentStreakDays: streaks.currentStreakDays,
    longestStreakDays: streaks.longestStreakDays,
    requests: queries.length,
    autoTokens,
    autoRequests,
    ...(input.messageEvents !== undefined ? { userMessages: input.messageEvents.length } : {}),
    turns,
    ...(hasModelCallData ? { modelCalls } : {}),
    chatCount: input.chatCount,
    agentSessionCount: input.sessions.length,
    fastModeRate: fastModeEligibleCount > 0 ? fastModeCount / fastModeEligibleCount : 0,
    skillsExplored: skills.length,
    skillUses: skills.reduce((sum, item) => sum + item.uses, 0),
  }

  return {
    checkedAt: now.getTime(),
    stats,
    days,
    models: Array.from(byModel.values()).sort((a, b) => b.requests - a.requests || b.tokens - a.tokens),
    skills,
  }
}

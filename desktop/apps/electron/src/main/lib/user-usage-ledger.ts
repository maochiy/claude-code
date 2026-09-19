/**
 * 本地模型用量账本。
 *
 * Claude CLI 的 result.usage 与 result.modelUsage 都可能是当前进程的累计快照。
 * 本模块把累计快照归一化成单轮增量，并按桌面 Session、原生 Session、进程代次
 * 和恢复基线去重。它不读写磁盘，JSONL 扫描和未来实时事件可以共用同一套规则。
 */

export interface UsageTokenSnapshot {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export interface UsageCumulativeSnapshot {
  sessionId: string
  nativeSessionId?: string
  processGeneration?: string
  eventId?: string
  createdAt: number
  durationMs: number
  fastMode: boolean
  modelCalls?: number
  usage: UsageTokenSnapshot
  models: Record<string, UsageTokenSnapshot>
}

/** 不包含在 result 累计值中的独立模型调用，例如 Auto classifier side query。 */
export interface UsageDiscreteSnapshot {
  sessionId: string
  callId: string
  createdAt: number
  durationMs: number
  source: 'auto'
  modelId: string
  usage: UsageTokenSnapshot
}

export interface UsageLedgerDelta {
  sessionId: string
  nativeSessionId?: string
  processGeneration: string
  eventId?: string
  createdAt: number
  durationMs: number
  fastMode: boolean
  /** 一条终态 result 对应一个用户轮次。 */
  turns: 1
  /** CLI 明确上报的模型调用数；缺失时保留 undefined。 */
  modelCalls?: number
  usage: Required<UsageTokenSnapshot>
  models: Array<{ modelId: string } & Required<UsageTokenSnapshot>>
  /** true 表示本轮总量来自逐模型累计快照差额。 */
  fromModelUsage: boolean
}

export interface UsageDiscreteDelta {
  sessionId: string
  callId: string
  createdAt: number
  durationMs: number
  source: 'auto'
  turns: 0
  modelCalls: 1
  usage: Required<UsageTokenSnapshot>
  models: Array<{ modelId: string } & Required<UsageTokenSnapshot>>
}

interface SessionLedgerState {
  generation: string
  nativeSessionId?: string
  implicitGeneration: number
  usage?: UsageTokenSnapshot
  models: Map<string, UsageTokenSnapshot>
  seenEventIds: Set<string>
}

const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
] as const

function finiteToken(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return Math.max(0, value)
}

function normalizeSnapshot(value: UsageTokenSnapshot): UsageTokenSnapshot {
  const result: UsageTokenSnapshot = {}
  for (const field of TOKEN_FIELDS) {
    const token = finiteToken(value[field])
    if (token !== undefined) result[field] = token
  }
  return result
}

function completeSnapshot(value: UsageTokenSnapshot): Required<UsageTokenSnapshot> {
  return {
    inputTokens: value.inputTokens ?? 0,
    outputTokens: value.outputTokens ?? 0,
    cacheReadTokens: value.cacheReadTokens ?? 0,
    cacheCreationTokens: value.cacheCreationTokens ?? 0,
  }
}

function hasTokenFields(value: UsageTokenSnapshot | undefined): value is UsageTokenSnapshot {
  return Boolean(value && TOKEN_FIELDS.some((field) => value[field] !== undefined))
}

function hasPositiveTokens(value: UsageTokenSnapshot): boolean {
  return TOKEN_FIELDS.some((field) => (value[field] ?? 0) > 0)
}

function snapshotWentBackwards(current: UsageTokenSnapshot, previous: UsageTokenSnapshot | undefined): boolean {
  if (!previous) return false
  return TOKEN_FIELDS.some((field) => {
    const next = current[field]
    const before = previous[field]
    return next !== undefined && before !== undefined && next < before
  })
}

function subtractSnapshot(
  currentValue: UsageTokenSnapshot,
  previousValue: UsageTokenSnapshot | undefined,
  reset: boolean,
): Required<UsageTokenSnapshot> {
  const current = normalizeSnapshot(currentValue)
  const previous = normalizeSnapshot(previousValue ?? {})
  const delta: UsageTokenSnapshot = {}
  for (const field of TOKEN_FIELDS) {
    const next = current[field]
    if (next === undefined) continue
    delta[field] = reset ? next : Math.max(0, next - (previous[field] ?? 0))
  }
  return completeSnapshot(delta)
}

function addSnapshots(values: UsageTokenSnapshot[]): Required<UsageTokenSnapshot> {
  const total = completeSnapshot({})
  for (const value of values) {
    for (const field of TOKEN_FIELDS) total[field] += value[field] ?? 0
  }
  return total
}

function generationKey(snapshot: UsageCumulativeSnapshot): string {
  const native = snapshot.nativeSessionId?.trim() || 'unknown-native-session'
  const process = snapshot.processGeneration?.trim() || 'legacy-process'
  return `${native}:${process}`
}

/**
 * 累计快照归一化器。
 *
 * 新进程恢复同一原生 Session 时，第一份累计值通常包含旧基线；只计算相对上份快照
 * 的增长。若任意已知计数回退，则视为内核清空了累计器，当前快照成为新代次首个增量。
 */
export class UserUsageLedger {
  private readonly sessions = new Map<string, SessionLedgerState>()
  private readonly seenDiscreteCalls = new Set<string>()

  apply(snapshot: UsageCumulativeSnapshot): UsageLedgerDelta | null {
    const normalizedEventId = snapshot.eventId?.trim()
    const requestedGeneration = generationKey(snapshot)
    const state = this.sessions.get(snapshot.sessionId) ?? {
      generation: requestedGeneration,
      ...(snapshot.nativeSessionId ? { nativeSessionId: snapshot.nativeSessionId } : {}),
      implicitGeneration: 0,
      models: new Map<string, UsageTokenSnapshot>(),
      seenEventIds: new Set<string>(),
    }

    if (normalizedEventId && state.seenEventIds.has(normalizedEventId)) return null
    if (normalizedEventId) state.seenEventIds.add(normalizedEventId)

    const normalizedUsage = normalizeSnapshot(snapshot.usage)
    const normalizedModels = new Map<string, UsageTokenSnapshot>()
    for (const [modelId, usage] of Object.entries(snapshot.models)) {
      if (!modelId || !hasTokenFields(usage)) continue
      normalizedModels.set(modelId, normalizeSnapshot(usage))
    }

    const generationChanged = state.generation !== requestedGeneration
    const nativeSessionChanged = Boolean(
      state.nativeSessionId && snapshot.nativeSessionId
      && state.nativeSessionId !== snapshot.nativeSessionId,
    )
    const totalWentBackwards = snapshotWentBackwards(normalizedUsage, state.usage)
    const modelWentBackwards = Array.from(normalizedModels.entries()).some(
      ([modelId, usage]) => snapshotWentBackwards(usage, state.models.get(modelId)),
    )
    const countersReset = nativeSessionChanged || totalWentBackwards || modelWentBackwards
    if (generationChanged) state.generation = requestedGeneration
    if (snapshot.nativeSessionId) state.nativeSessionId = snapshot.nativeSessionId
    if (countersReset) state.implicitGeneration += 1

    // 进程切换但累计器恢复成功时，旧快照就是恢复基线；计数回退才从零开始。
    const reset = countersReset
    const modelDeltas = Array.from(normalizedModels.entries()).map(([modelId, usage]) => ({
      modelId,
      ...subtractSnapshot(usage, state.models.get(modelId), reset),
    }))
    const resultDelta = subtractSnapshot(normalizedUsage, state.usage, reset)
    const positiveModelDeltas = modelDeltas.filter(hasPositiveTokens)
    const modelTotal = addSnapshots(positiveModelDeltas)
    const fromModelUsage = normalizedModels.size > 0
      && (hasPositiveTokens(modelTotal) || !hasPositiveTokens(resultDelta))
    const usage = fromModelUsage ? modelTotal : resultDelta

    if (hasTokenFields(normalizedUsage)) state.usage = normalizedUsage
    for (const [modelId, modelUsage] of normalizedModels) state.models.set(modelId, modelUsage)
    this.sessions.set(snapshot.sessionId, state)

    // 部分 Runtime 会以新的 eventId 重放相同累计 result，或在父/子 Agent
    // 结束时各写一份相同快照。零增量不能新增请求、轮次和模型调用。
    if (!hasPositiveTokens(usage)) return null

    return {
      sessionId: snapshot.sessionId,
      ...(snapshot.nativeSessionId ? { nativeSessionId: snapshot.nativeSessionId } : {}),
      processGeneration: `${state.generation}:${state.implicitGeneration}`,
      ...(normalizedEventId ? { eventId: normalizedEventId } : {}),
      createdAt: snapshot.createdAt,
      durationMs: snapshot.durationMs,
      fastMode: snapshot.fastMode,
      turns: 1,
      ...(snapshot.modelCalls !== undefined ? { modelCalls: Math.max(0, snapshot.modelCalls) } : {}),
      usage,
      models: positiveModelDeltas,
      fromModelUsage,
    }
  }

  /**
   * 记录不进入 result 累计器的离散调用。callId 是原生调用的稳定身份，
   * JSONL 重放或 checking/final 重复写入都不能造成二次计费。
   */
  applyDiscrete(snapshot: UsageDiscreteSnapshot): UsageDiscreteDelta | null {
    const callId = snapshot.callId.trim()
    if (!callId) return null
    const dedupeKey = `${snapshot.sessionId}\u0000${snapshot.source}\u0000${callId}`
    if (this.seenDiscreteCalls.has(dedupeKey)) return null

    const usage = completeSnapshot(normalizeSnapshot(snapshot.usage))
    if (!hasPositiveTokens(usage)) return null
    this.seenDiscreteCalls.add(dedupeKey)
    const modelId = snapshot.modelId.trim() || 'unknown'
    return {
      sessionId: snapshot.sessionId,
      callId,
      createdAt: snapshot.createdAt,
      durationMs: snapshot.durationMs,
      source: snapshot.source,
      turns: 0,
      modelCalls: 1,
      usage,
      models: [{ modelId, ...usage }],
    }
  }
}

export function normalizeUsageSnapshots(snapshots: UsageCumulativeSnapshot[]): UsageLedgerDelta[] {
  const ledger = new UserUsageLedger()
  const deltas: UsageLedgerDelta[] = []
  for (const snapshot of snapshots) {
    const delta = ledger.apply(snapshot)
    if (delta) deltas.push(delta)
  }
  return deltas
}

export function normalizeDiscreteUsageSnapshots(
  snapshots: UsageDiscreteSnapshot[],
): UsageDiscreteDelta[] {
  const ledger = new UserUsageLedger()
  const deltas: UsageDiscreteDelta[] = []
  for (const snapshot of snapshots) {
    const delta = ledger.applyDiscrete(snapshot)
    if (delta) deltas.push(delta)
  }
  return deltas
}

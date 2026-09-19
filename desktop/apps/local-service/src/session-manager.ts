import type {
  AcceptedResult,
  CliLaunchSpec,
  DesktopEvent,
  SessionControlParams,
  SessionEventCursor,
  SessionInterruptParams,
  SessionOpenParams,
  SessionOpenResult,
  SessionRespondParams,
  SessionSendParams,
  SessionSnapshot,
  TaskOutputResult,
} from '@proma/desktop-protocol'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceError } from './errors.ts'
import { LocalCliSession, getSessionOpenFingerprint } from './session.ts'

export type ManagerEventListener = (event: DesktopEvent) => void

const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1_000
const DEFAULT_MAX_IDLE_SESSIONS = 8
const DEFAULT_EVICTION_SWEEP_MS = 60 * 1_000

export interface SessionManagerEvictionOptions {
  idleTtlMs?: number
  maxIdleSessions?: number
  sweepIntervalMs?: number
  now?: () => number
}

export function compareDesktopEvents(
  left: DesktopEvent,
  right: DesktopEvent,
): number {
  const bySession = left.sessionId.localeCompare(right.sessionId)
  if (bySession !== 0) return bySession
  const byGeneration = left.generation - right.generation
  if (byGeneration !== 0) return byGeneration
  const bySequence = left.seq - right.seq
  return bySequence !== 0 ? bySequence : left.eventId.localeCompare(right.eventId)
}

export class SessionManager {
  private readonly sessions = new Map<string, LocalCliSession>()
  private readonly generations = new Map<string, number>()
  private readonly listeners = new Set<ManagerEventListener>()
  private shuttingDown = false
  private evictionInProgress = false
  private readonly stateDir: string
  private readonly idleTtlMs: number
  private readonly maxIdleSessions: number
  private readonly now: () => number
  private readonly evictionTimer: ReturnType<typeof setInterval> | null

  constructor(
    private readonly defaultCli?: CliLaunchSpec,
    stateDir?: string,
    eviction: SessionManagerEvictionOptions = {},
  ) {
    this.stateDir =
      stateDir ?? join(tmpdir(), `xcodes-local-service-${process.pid}`)
    this.idleTtlMs = eviction.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    this.maxIdleSessions =
      eviction.maxIdleSessions ?? DEFAULT_MAX_IDLE_SESSIONS
    this.now = eviction.now ?? Date.now
    mkdirSync(this.stateDir, { recursive: true })
    const sweepIntervalMs =
      eviction.sweepIntervalMs ?? DEFAULT_EVICTION_SWEEP_MS
    this.evictionTimer =
      sweepIntervalMs > 0
        ? setInterval(
            () => void this.sweepIdleSessions().catch(() => undefined),
            sweepIntervalMs,
          )
        : null
    this.evictionTimer?.unref?.()
  }

  get size(): number {
    return this.sessions.size
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown
  }

  subscribe(listener: ManagerEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async open(params: SessionOpenParams): Promise<SessionOpenResult> {
    if (this.shuttingDown) {
      throw new ServiceError('SERVICE_SHUTTING_DOWN', '本地服务正在退出')
    }
    const existing = this.sessions.get(params.sessionId)
    if (existing) {
      if (
        getSessionOpenFingerprint(params, this.defaultCli) !==
        existing.fingerprint
      ) {
        throw new ServiceError(
          'SESSION_CONFIG_CONFLICT',
          '同名会话已经使用不同配置打开，请先关闭后重建',
        )
      }
      existing.markAccessed()
      return existing.openResult()
    }

    const generation = this.nextGeneration(params.sessionId)
    this.generations.set(params.sessionId, generation)
    const session = new LocalCliSession({
      open: params,
      generation,
      defaultCli: this.defaultCli,
      journalPath: this.journalPath(params.sessionId, generation),
      onEvent: event => this.publish(event),
      now: this.now,
    })
    this.sessions.set(params.sessionId, session)
    try {
      return await session.start()
    } catch (error) {
      this.sessions.delete(params.sessionId)
      throw error
    }
  }

  async close(sessionId: string): Promise<{ closed: boolean }> {
    const session = this.sessions.get(sessionId)
    if (!session) return { closed: false }
    await session.stop()
    this.sessions.delete(sessionId)
    return { closed: true }
  }

  list(): Promise<SessionSnapshot[]> {
    return Promise.all(
      [...this.sessions.values()].map(session => session.snapshot()),
    )
  }

  snapshot(sessionId: string, afterSeq = 0): Promise<SessionSnapshot> {
    return this.require(sessionId).snapshot(afterSeq)
  }

  send(params: SessionSendParams): AcceptedResult {
    return this.require(params.sessionId).send(params)
  }

  interrupt(params: SessionInterruptParams): AcceptedResult {
    return this.require(params.sessionId).interrupt(params)
  }

  control(params: SessionControlParams): AcceptedResult {
    return this.require(params.sessionId).control(params)
  }

  respond(params: SessionRespondParams): AcceptedResult {
    return this.require(params.sessionId).respond(params)
  }

  stopTask(
    sessionId: string,
    taskId: string,
    requestId: string,
  ): AcceptedResult {
    return this.require(sessionId).stopTask(taskId, requestId)
  }

  readTaskOutput(
    sessionId: string,
    taskId: string,
    offset?: number,
    limit?: number,
  ): Promise<TaskOutputResult> {
    return this.require(sessionId).readTaskOutput(taskId, offset, limit)
  }

  async replay(
    sessionId: string | undefined,
    afterSeq: number,
  ): Promise<DesktopEvent[]> {
    if (sessionId) {
      const session = this.sessions.get(sessionId)
      if (!session) return []
      const replay = await session.replay(afterSeq)
      return replay.truncated
        ? [...replay.events, session.emitReplayReset(replay)]
        : replay.events
    }
    const sessions = [...this.sessions.values()]
    const replayed = await Promise.all(
      sessions.map(session => session.replay(afterSeq)),
    )
    return replayed
      .flatMap((result, index) =>
        result.truncated
          ? [...result.events, sessions[index]!.emitReplayReset(result)]
          : result.events,
      )
      .sort(compareDesktopEvents)
  }

  async replayWithCursors(
    sessionId: string | undefined,
    cursors: ReadonlyMap<string, SessionEventCursor>,
    legacyAfterSeq = 0,
  ): Promise<DesktopEvent[]> {
    const sessions = sessionId
      ? [this.sessions.get(sessionId)].filter(
          (session): session is LocalCliSession => session !== undefined,
        )
      : [...this.sessions.values()]
    const replayed = await Promise.all(
      sessions.map(async session => {
        const cursor = cursors.get(session.sessionId)
        const afterSeq =
          cursor?.generation === session.generation
            ? cursor.seq
            : cursor
              ? 0
              : legacyAfterSeq
        const replay = await session.replay(afterSeq)
        return replay.truncated
          ? [...replay.events, session.emitReplayReset(replay)]
          : replay.events
      }),
    )
    return replayed
      .flat()
      .sort(compareDesktopEvents)
  }

  async sweepIdleSessions(): Promise<string[]> {
    if (this.shuttingDown || this.evictionInProgress) return []
    this.evictionInProgress = true
    try {
      const now = this.now()
      const candidates = [...this.sessions.values()]
        .map(session => ({ session, state: session.getEvictionState() }))
        .filter(candidate => candidate.state.safeToEvict)
        .sort(
          (left, right) =>
            left.state.lastActivityAt - right.state.lastActivityAt ||
            left.session.sessionId.localeCompare(right.session.sessionId),
        )
      const reasons = new Map<
        string,
        'idle_timeout' | 'idle_capacity'
      >()
      for (const candidate of candidates) {
        if (now - candidate.state.lastActivityAt >= this.idleTtlMs) {
          reasons.set(candidate.session.sessionId, 'idle_timeout')
        }
      }
      const remaining = candidates.filter(
        candidate => !reasons.has(candidate.session.sessionId),
      )
      const capacityExcess = Math.max(
        0,
        remaining.length - this.maxIdleSessions,
      )
      for (const candidate of remaining.slice(0, capacityExcess)) {
        reasons.set(candidate.session.sessionId, 'idle_capacity')
      }

      const evicted: string[] = []
      for (const candidate of candidates) {
        const reason = reasons.get(candidate.session.sessionId)
        if (!reason) continue
        if (this.sessions.get(candidate.session.sessionId) !== candidate.session) {
          continue
        }
        if (!candidate.session.getEvictionState().safeToEvict) continue
        await candidate.session.stop(reason)
        if (this.sessions.get(candidate.session.sessionId) === candidate.session) {
          this.sessions.delete(candidate.session.sessionId)
          evicted.push(candidate.session.sessionId)
        }
      }
      return evicted
    } finally {
      this.evictionInProgress = false
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    if (this.evictionTimer) clearInterval(this.evictionTimer)
    await Promise.allSettled(
      [...this.sessions.values()].map(session => session.stop()),
    )
    this.sessions.clear()
  }

  private require(sessionId: string): LocalCliSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new ServiceError('SESSION_NOT_FOUND', `会话不存在：${sessionId}`)
    }
    return session
  }

  private publish(event: DesktopEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private journalPath(sessionId: string, generation: number): string {
    const digest = this.sessionDigest(sessionId)
    return join(this.stateDir, `${digest}-${generation}.events.jsonl`)
  }

  private nextGeneration(sessionId: string): number {
    const inMemory = this.generations.get(sessionId) ?? 0
    const prefix = `${this.sessionDigest(sessionId)}-`
    let persisted = 0
    for (const file of readdirSync(this.stateDir)) {
      if (!file.startsWith(prefix) || !file.endsWith('.events.jsonl')) continue
      const raw = file.slice(prefix.length, -'.events.jsonl'.length)
      const generation = Number(raw)
      if (Number.isInteger(generation) && generation > persisted) {
        persisted = generation
      }
    }
    const next = Math.max(inMemory, persisted) + 1
    this.generations.set(sessionId, next)
    return next
  }

  private sessionDigest(sessionId: string): string {
    return createHash('sha256').update(sessionId).digest('hex').slice(0, 24)
  }
}

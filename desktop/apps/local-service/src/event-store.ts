import {
  DESKTOP_PROTOCOL_VERSION,
  type DesktopEvent,
  type DesktopEventKind,
  type JsonValue,
} from '@proma/desktop-protocol'
import { createWriteStream, type WriteStream } from 'node:fs'

const DEFAULT_EVENT_LIMIT = 2_000

export interface EventInput {
  source: 'service' | 'cli'
  kind: DesktopEventKind
  payload: JsonValue
  runId?: string
  requestId?: string
}

export type EventListener = (event: DesktopEvent) => void

export interface ReplayResult {
  events: DesktopEvent[]
  requestedAfterSeq: number
  oldestAvailableSeq: number
  currentSeq: number
  truncated: boolean
}

export class SessionEventStore {
  private seq = 0
  private readonly events: DesktopEvent[] = []
  private readonly listeners = new Set<EventListener>()
  private readonly journal: WriteStream | null
  private journalFailed = false

  constructor(
    private readonly sessionId: string,
    private readonly generation: number,
    private readonly limit = DEFAULT_EVENT_LIMIT,
    journalPath?: string,
  ) {
    this.journal = journalPath
      ? createWriteStream(journalPath, { flags: 'a', encoding: 'utf8' })
      : null
    this.journal?.on('error', () => {
      this.journalFailed = true
    })
  }

  get currentSeq(): number {
    return this.seq
  }

  append(input: EventInput): DesktopEvent {
    const seq = ++this.seq
    const event: DesktopEvent = {
      type: 'desktop_event',
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      eventId: `${this.sessionId}:${this.generation}:${seq}`,
      sessionId: this.sessionId,
      generation: this.generation,
      seq,
      timestamp: Date.now(),
      source: input.source,
      kind: input.kind,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.requestId === undefined
        ? {}
        : { requestId: input.requestId }),
      payload: input.payload,
    }
    this.events.push(event)
    this.journal?.write(`${JSON.stringify(event)}\n`)
    if (this.events.length > this.limit) this.events.shift()
    for (const listener of this.listeners) listener(event)
    return event
  }

  async replay(afterSeq = 0): Promise<ReplayResult> {
    const safeAfterSeq = Math.max(0, Math.floor(afterSeq))
    const oldestRetainedSeq = this.events[0]?.seq ?? this.seq + 1
    if (safeAfterSeq >= oldestRetainedSeq - 1 || !this.journal) {
      return {
        events: this.events.filter(event => event.seq > safeAfterSeq),
        requestedAfterSeq: safeAfterSeq,
        oldestAvailableSeq: oldestRetainedSeq,
        currentSeq: this.seq,
        truncated:
          safeAfterSeq < oldestRetainedSeq - 1 && this.journal === null,
      }
    }

    await this.flushJournal()
    const journalPath = this.journal.path
    const diskEvents: DesktopEvent[] = []
    if (typeof journalPath === 'string') {
      try {
        const content = await Bun.file(journalPath).text()
        for (const line of content.split('\n')) {
          if (!line) continue
          const parsed = JSON.parse(line) as DesktopEvent
          if (
            parsed.sessionId === this.sessionId &&
            parsed.generation === this.generation &&
            parsed.seq > safeAfterSeq
          ) {
            diskEvents.push(parsed)
          }
        }
      } catch {
        this.journalFailed = true
      }
    }
    const combined = new Map<number, DesktopEvent>()
    for (const event of diskEvents) combined.set(event.seq, event)
    for (const event of this.events) {
      if (event.seq > safeAfterSeq) combined.set(event.seq, event)
    }
    const events = [...combined.values()].sort((a, b) => a.seq - b.seq)
    const oldestAvailableSeq = events[0]?.seq ?? oldestRetainedSeq
    return {
      events,
      requestedAfterSeq: safeAfterSeq,
      oldestAvailableSeq,
      currentSeq: this.seq,
      truncated:
        this.journalFailed ||
        (safeAfterSeq < this.seq && oldestAvailableSeq > safeAfterSeq + 1),
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async close(): Promise<void> {
    if (!this.journal || this.journal.closed) return
    await new Promise<void>(resolve => this.journal!.end(resolve))
  }

  private async flushJournal(): Promise<void> {
    if (!this.journal || this.journal.destroyed) return
    await new Promise<void>(resolve => {
      this.journal!.write('', () => resolve())
    })
  }
}

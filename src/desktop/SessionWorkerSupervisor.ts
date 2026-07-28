import { fork } from 'node:child_process'
import { availableParallelism } from 'node:os'
import type {
  RuntimeCommand,
  RuntimeEnvelope,
  RuntimeEvent,
  WorkerCommandMessage,
  WorkerEventMessage,
} from './protocol/types.js'
import { DESKTOP_PROTOCOL_VERSION } from './protocol/types.js'
import {
  buildDesktopWorkerEnvironment,
  redactRuntimeSecrets,
} from './bootstrap/environment.js'
import { assertEventEnvelope } from './protocol/validation.js'

interface SupervisorTimer {
  unref?(): void
}

export interface SessionWorkerProcess {
  killed: boolean
  stderr?: {
    on(event: 'data', listener: (chunk: unknown) => void): unknown
  } | null
  on(event: 'message', listener: (value: unknown) => void): this
  once(
    event: 'exit',
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): this
  send(message: WorkerCommandMessage): boolean
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface SessionWorkerSupervisorDependencies {
  spawnWorkerProcess(
    workerEntrypoint: string,
    environment: NodeJS.ProcessEnv,
  ): SessionWorkerProcess
  now(): number
  setTimeout(callback: () => void, delayMs: number): SupervisorTimer
  clearTimeout(timer: SupervisorTimer): void
  setInterval(callback: () => void, delayMs: number): SupervisorTimer
  clearInterval(timer: SupervisorTimer): void
  maxActiveWorkers: number
  idleTimeoutMs: number
  idleSweepIntervalMs: number
  shutdownGraceMs: number
}

interface WorkerSlot {
  process: SessionWorkerProcess
  sessionId?: string
  crashes: number
  lastActiveAt: number
  initialized: boolean
  busy: boolean
  stopping: boolean
  lastOpenEnvelope?: RuntimeEnvelope<RuntimeCommand>
  commandQueue: RuntimeEnvelope<RuntimeCommand>[]
  statelessRequestIds: Set<string>
}

function createDefaultDependencies(): SessionWorkerSupervisorDependencies {
  return {
    spawnWorkerProcess: (workerEntrypoint, environment) =>
      fork(workerEntrypoint, [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: environment,
      }),
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: timer => clearInterval(timer as NodeJS.Timeout),
    maxActiveWorkers: Math.min(
      4,
      Math.max(2, Math.floor(availableParallelism() / 2)),
    ),
    idleTimeoutMs: 10 * 60_000,
    idleSweepIntervalMs: 60_000,
    shutdownGraceMs: 5_000,
  }
}

export class SessionWorkerSupervisor {
  private readonly workers = new Map<string, WorkerSlot>()
  private readonly pending: RuntimeEnvelope<RuntimeCommand>[] = []
  private readonly sequences = new Map<string, number>()
  private readonly dependencies: SessionWorkerSupervisorDependencies
  private readonly idleTimer: SupervisorTimer
  private prewarmedWorker?: WorkerSlot
  private shuttingDown = false

  constructor(
    private readonly workerEntrypoint: string,
    private readonly emit: (envelope: RuntimeEnvelope<RuntimeEvent>) => void,
    dependencies?: Partial<SessionWorkerSupervisorDependencies>,
  ) {
    this.dependencies = {
      ...createDefaultDependencies(),
      ...dependencies,
    }
    this.idleTimer = this.dependencies.setInterval(
      () => this.reapIdleWorkers(),
      this.dependencies.idleSweepIntervalMs,
    )
    this.idleTimer.unref?.()
    this.ensurePrewarmedWorker()
  }

  async dispatch(envelope: RuntimeEnvelope<RuntimeCommand>): Promise<void> {
    const sessionId = envelope.sessionId
    if (!sessionId) throw new Error(`${envelope.payload.type} 缺少 sessionId`)

    let slot = this.workers.get(sessionId)
    if (!slot) {
      if (this.pending.some(item => item.sessionId === sessionId)) {
        this.pending.push(envelope)
        return
      }
      if (this.workers.size >= this.dependencies.maxActiveWorkers) {
        const idle = this.findOldestIdleWorker()
        if (idle) {
          this.retireWorker(idle)
        } else {
          this.pending.push(envelope)
          this.emitSequenced(sessionId, {
            ...envelope,
            sequence: undefined,
            payload: { type: 'session.stateChanged', state: 'cold' },
          })
          return
        }
      }
      slot = this.acquireWorker(sessionId, 0)
    }

    slot.lastActiveAt = this.dependencies.now()
    this.sendOrQueue(slot, envelope)
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.dependencies.clearInterval(this.idleTimer)
    this.pending.length = 0

    const workers = [
      ...this.workers.values(),
      ...(this.prewarmedWorker ? [this.prewarmedWorker] : []),
    ]
    this.workers.clear()
    this.prewarmedWorker = undefined

    await Promise.all(
      workers.map(
        slot =>
          new Promise<void>(resolve => {
            slot.stopping = true
            const timer = this.dependencies.setTimeout(() => {
              slot.process.kill('SIGKILL')
              resolve()
            }, this.dependencies.shutdownGraceMs)
            slot.process.once('exit', () => {
              this.dependencies.clearTimeout(timer)
              resolve()
            })
            slot.process.kill('SIGTERM')
          }),
      ),
    )
  }

  private acquireWorker(sessionId: string, crashes: number): WorkerSlot {
    const slot =
      this.prewarmedWorker && !this.prewarmedWorker.process.killed
        ? this.prewarmedWorker
        : this.spawnWorker(undefined, crashes)
    this.prewarmedWorker = undefined
    slot.sessionId = sessionId
    slot.crashes = crashes
    slot.lastActiveAt = this.dependencies.now()
    slot.initialized = false
    slot.busy = false
    slot.stopping = false
    slot.commandQueue.length = 0
    slot.statelessRequestIds.clear()
    this.workers.set(sessionId, slot)
    this.ensurePrewarmedWorker()
    return slot
  }

  private spawnWorker(
    sessionId: string | undefined,
    crashes: number,
  ): WorkerSlot {
    const child = this.dependencies.spawnWorkerProcess(
      this.workerEntrypoint,
      buildDesktopWorkerEnvironment(process.env),
    )
    const slot: WorkerSlot = {
      process: child,
      sessionId,
      crashes,
      lastActiveAt: this.dependencies.now(),
      initialized: false,
      busy: false,
      stopping: false,
      commandQueue: [],
      statelessRequestIds: new Set(),
    }

    child.on('message', (value: unknown) => {
      if (
        !value ||
        typeof value !== 'object' ||
        (value as { kind?: string }).kind !== 'event'
      ) {
        return
      }
      const envelope = (value as WorkerEventMessage).envelope
      try {
        assertEventEnvelope(envelope)
      } catch (error) {
        const message = redactRuntimeSecrets(
          error instanceof Error ? error.message : String(error),
        )
        const currentSessionId = slot.sessionId
        if (currentSessionId) {
          this.emitSequenced(currentSessionId, {
            protocolVersion: DESKTOP_PROTOCOL_VERSION,
            requestId: `invalid-worker-event-${this.dependencies.now()}`,
            sessionId: currentSessionId,
            timestamp: this.dependencies.now(),
            payload: {
              type: 'runtime.log',
              level: 'error',
              message: `Session Worker 事件校验失败: ${message}`,
            },
          })
        }
        return
      }
      const currentSessionId = slot.sessionId
      if (!currentSessionId) return
      if (envelope.payload.type === 'session.stateChanged') {
        slot.busy = envelope.payload.state === 'busy'
        slot.lastActiveAt = this.dependencies.now()
        if (envelope.payload.state === 'ready') {
          slot.initialized = true
          this.flushWorkerQueue(slot)
          this.drainPending()
        }
      }
      this.emitSequenced(currentSessionId, envelope)
      if (
        (envelope.payload.type === 'response.success' ||
          envelope.payload.type === 'response.failure') &&
        slot.statelessRequestIds.delete(envelope.payload.responseTo) &&
        slot.statelessRequestIds.size === 0
      ) {
        this.retireStatelessWorker(slot)
      }
    })

    child.stderr?.on('data', chunk => {
      const message = redactRuntimeSecrets(String(chunk))
      const currentSessionId = slot.sessionId
      if (currentSessionId) {
        this.emitSequenced(currentSessionId, {
          protocolVersion: DESKTOP_PROTOCOL_VERSION,
          requestId: `log-${this.dependencies.now()}`,
          sessionId: currentSessionId,
          timestamp: this.dependencies.now(),
          payload: { type: 'runtime.log', level: 'error', message },
        })
        return
      }
      this.emit({
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        requestId: `host-log-${this.dependencies.now()}`,
        timestamp: this.dependencies.now(),
        payload: { type: 'runtime.log', level: 'error', message },
      })
    })

    child.once('exit', (exitCode, signal) => {
      this.handleWorkerExit(slot, exitCode, signal)
    })
    return slot
  }

  private handleWorkerExit(
    slot: WorkerSlot,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const sessionId = slot.sessionId
    if (!sessionId) {
      if (this.prewarmedWorker === slot) this.prewarmedWorker = undefined
      if (!this.shuttingDown) this.ensurePrewarmedWorker()
      return
    }

    const current = this.workers.get(sessionId)
    if (!current || current !== slot) return
    this.workers.delete(sessionId)
    if (slot.stopping || this.shuttingDown) {
      this.drainPending()
      return
    }

    this.emitSequenced(sessionId, {
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      requestId: `crash-${this.dependencies.now()}`,
      sessionId,
      timestamp: this.dependencies.now(),
      payload: {
        type: 'worker.crashed',
        exitCode,
        signal,
        recoverable: slot.crashes < 3,
      },
    })

    const lastOpenEnvelope = slot.lastOpenEnvelope
    if (slot.crashes < 3 && lastOpenEnvelope) {
      const restartTimer = this.dependencies.setTimeout(
        () => {
          if (this.shuttingDown || this.workers.has(sessionId)) return
          const replacement = this.acquireWorker(sessionId, slot.crashes + 1)
          replacement.lastOpenEnvelope = lastOpenEnvelope
          const recoveryEnvelope: RuntimeEnvelope<RuntimeCommand> = {
            ...lastOpenEnvelope,
            requestId: `recovery-${this.dependencies.now()}`,
            timestamp: this.dependencies.now(),
            payload:
              lastOpenEnvelope.payload.type === 'session.open'
                ? {
                    type: 'session.resume',
                    options: {
                      ...lastOpenEnvelope.payload.options,
                      resume: true,
                    },
                  }
                : lastOpenEnvelope.payload,
          }
          this.sendOrQueue(replacement, recoveryEnvelope)
        },
        Math.min(4_000, 500 * 2 ** slot.crashes),
      )
      restartTimer.unref?.()
    }
    this.drainPending()
  }

  private sendOrQueue(
    slot: WorkerSlot,
    envelope: RuntimeEnvelope<RuntimeCommand>,
  ): void {
    if (
      envelope.payload.type === 'session.open' ||
      envelope.payload.type === 'session.resume'
    ) {
      slot.lastOpenEnvelope = envelope
      slot.initialized = false
      this.send(slot, envelope)
      return
    }
    if (
      envelope.payload.type === 'session.resolveModelCatalog' ||
      envelope.payload.type === 'session.resolveSkillCatalog' ||
      envelope.payload.type === 'session.list' ||
      envelope.payload.type === 'session.getTranscript' ||
      envelope.payload.type === 'session.delete'
    ) {
      slot.statelessRequestIds.add(envelope.requestId)
      this.send(slot, envelope)
      return
    }
    if (!slot.initialized) {
      slot.commandQueue.push(envelope)
      return
    }
    this.send(slot, envelope)
  }

  private send(
    slot: WorkerSlot,
    envelope: RuntimeEnvelope<RuntimeCommand>,
  ): void {
    slot.process.send({ kind: 'command', envelope })
  }

  private flushWorkerQueue(slot: WorkerSlot): void {
    if (!slot.initialized || slot.commandQueue.length === 0) return
    const queued = slot.commandQueue.splice(0)
    for (const envelope of queued) this.send(slot, envelope)
  }

  private ensurePrewarmedWorker(): void {
    if (
      this.shuttingDown ||
      (this.prewarmedWorker && !this.prewarmedWorker.process.killed)
    ) {
      return
    }
    this.prewarmedWorker = this.spawnWorker(undefined, 0)
  }

  private reapIdleWorkers(): void {
    const cutoff = this.dependencies.now() - this.dependencies.idleTimeoutMs
    for (const slot of this.workers.values()) {
      if (slot.busy || slot.lastActiveAt >= cutoff) continue
      this.retireWorker(slot)
    }
  }

  private findOldestIdleWorker(): WorkerSlot | undefined {
    return [...this.workers.values()]
      .filter(item => !item.process.killed && !item.busy && !item.stopping)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]
  }

  private retireStatelessWorker(slot: WorkerSlot): void {
    if (slot.stopping) return
    slot.stopping = true
    const sessionId = slot.sessionId
    if (sessionId) this.workers.delete(sessionId)
    this.terminateWorker(slot)
    this.drainPending()
  }

  private retireWorker(slot: WorkerSlot): void {
    if (slot.stopping) return
    slot.stopping = true
    const sessionId = slot.sessionId
    if (!sessionId) return
    this.workers.delete(sessionId)
    this.emitSequenced(sessionId, {
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      requestId: `suspend-${this.dependencies.now()}`,
      sessionId,
      timestamp: this.dependencies.now(),
      payload: {
        type: 'session.stateChanged',
        state: 'suspended',
        runtimeSessionId:
          slot.lastOpenEnvelope?.payload.type === 'session.open' ||
          slot.lastOpenEnvelope?.payload.type === 'session.resume'
            ? slot.lastOpenEnvelope.payload.options.runtimeSessionId
            : undefined,
      },
    })
    this.terminateWorker(slot)
  }

  /**
   * 普通回收也必须具备 shutdown 同等级别的强制退出兜底。
   *
   * Stateless Worker 没有 Headless Session，历史实现收到 SIGTERM 后可能没有
   * 真正 process.exit，导致每次 Catalog/Transcript 查询都残留一个进程。
   */
  private terminateWorker(slot: WorkerSlot): void {
    const timer = this.dependencies.setTimeout(() => {
      slot.process.kill('SIGKILL')
    }, this.dependencies.shutdownGraceMs)
    timer.unref?.()
    slot.process.once('exit', () => {
      this.dependencies.clearTimeout(timer)
    })
    slot.process.kill('SIGTERM')
  }

  private drainPending(): void {
    if (this.pending.length === 0) return
    const nextSessionId = this.pending[0]?.sessionId
    if (!nextSessionId || this.workers.has(nextSessionId)) return

    if (this.workers.size >= this.dependencies.maxActiveWorkers) {
      const idle = this.findOldestIdleWorker()
      if (!idle) return
      this.retireWorker(idle)
    }

    const slot = this.acquireWorker(nextSessionId, 0)
    const commands = this.pending.filter(
      item => item.sessionId === nextSessionId,
    )
    for (let index = this.pending.length - 1; index >= 0; index--) {
      if (this.pending[index]?.sessionId === nextSessionId) {
        this.pending.splice(index, 1)
      }
    }
    for (const command of commands) this.sendOrQueue(slot, command)
  }

  private emitSequenced(
    sessionId: string,
    envelope: RuntimeEnvelope<RuntimeEvent>,
  ): void {
    const sequence = (this.sequences.get(sessionId) ?? 0) + 1
    this.sequences.set(sessionId, sequence)
    this.emit({ ...envelope, sessionId, sequence })
  }
}

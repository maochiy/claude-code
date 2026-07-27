import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type {
  RuntimeCommand,
  RuntimeEnvelope,
  RuntimeEvent,
  WorkerCommandMessage,
  WorkerEventMessage,
} from './protocol/types.js'
import {
  SessionWorkerSupervisor,
  type SessionWorkerProcess,
  type SessionWorkerSupervisorDependencies,
} from './SessionWorkerSupervisor.js'

interface FakeTimer {
  callback: () => void
  delayMs: number
  cleared: boolean
  unref(): void
}

class FakeWorkerProcess extends EventEmitter implements SessionWorkerProcess {
  killed = false
  readonly sent: WorkerCommandMessage[] = []
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = []
  readonly stderr = new EventEmitter()

  send(message: WorkerCommandMessage): boolean {
    this.sent.push(message)
    return true
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal)
    if (signal === 'SIGKILL') this.killed = true
    return true
  }

  emitRuntimeEvent(
    sessionId: string,
    payload: RuntimeEvent,
    requestId = 'worker-event',
  ): void {
    const message: WorkerEventMessage = {
      kind: 'event',
      envelope: {
        protocolVersion: 1,
        requestId,
        sessionId,
        timestamp: 1,
        payload,
      },
    }
    this.emit('message', message)
  }

  exit(
    exitCode: number | null = 1,
    signal: NodeJS.Signals | null = null,
  ): void {
    this.emit('exit', exitCode, signal)
  }
}

class SupervisorHarness {
  now = 1_000
  readonly workers: FakeWorkerProcess[] = []
  readonly timers: FakeTimer[] = []
  readonly intervals: FakeTimer[] = []
  readonly events: Array<RuntimeEnvelope<RuntimeEvent>> = []
  readonly supervisor: SessionWorkerSupervisor

  constructor(maxActiveWorkers = 2, idleTimeoutMs = 10 * 60_000) {
    const dependencies: Partial<SessionWorkerSupervisorDependencies> = {
      spawnWorkerProcess: () => {
        const worker = new FakeWorkerProcess()
        this.workers.push(worker)
        return worker
      },
      now: () => this.now,
      setTimeout: (callback, delayMs) => {
        const timer = this.createTimer(callback, delayMs)
        this.timers.push(timer)
        return timer
      },
      clearTimeout: timer => {
        ;(timer as FakeTimer).cleared = true
      },
      setInterval: (callback, delayMs) => {
        const timer = this.createTimer(callback, delayMs)
        this.intervals.push(timer)
        return timer
      },
      clearInterval: timer => {
        ;(timer as FakeTimer).cleared = true
      },
      maxActiveWorkers,
      idleTimeoutMs,
      idleSweepIntervalMs: 60_000,
      shutdownGraceMs: 5_000,
    }
    this.supervisor = new SessionWorkerSupervisor(
      '/runtime/session-worker.js',
      envelope => this.events.push(envelope),
      dependencies,
    )
  }

  command(
    sessionId: string,
    payload: RuntimeCommand,
    requestId = `${sessionId}-${payload.type}`,
  ): RuntimeEnvelope<RuntimeCommand> {
    return {
      protocolVersion: 1,
      requestId,
      sessionId,
      timestamp: this.now,
      payload,
    }
  }

  open(
    sessionId: string,
    runtimeSessionId = `${sessionId}-runtime`,
  ): RuntimeEnvelope<RuntimeCommand> {
    return this.command(sessionId, {
      type: 'session.open',
      options: {
        cwd: `/tmp/${sessionId}`,
        runtimeSessionId,
        permissionMode: 'default',
        environment: {
          variables: {},
          configDir: `/tmp/${sessionId}/config`,
        },
      },
    })
  }

  activeWorker(index = 0): FakeWorkerProcess {
    return this.workers[index]!
  }

  workerForSession(sessionId: string): FakeWorkerProcess {
    return this.workers.find(worker =>
      worker.sent.some(message => message.envelope.sessionId === sessionId),
    )!
  }

  runTimer(index = 0): void {
    const timer = this.timers[index]
    if (!timer || timer.cleared) return
    timer.callback()
  }

  runIdleSweep(): void {
    this.intervals[0]?.callback()
  }

  private createTimer(callback: () => void, delayMs: number): FakeTimer {
    return {
      callback,
      delayMs,
      cleared: false,
      unref: () => undefined,
    }
  }
}

describe('SessionWorkerSupervisor', () => {
  test('预热 Worker 被首个 Session 复用，并立即补充新的预热 Worker', async () => {
    const harness = new SupervisorHarness()
    expect(harness.workers).toHaveLength(1)

    await harness.supervisor.dispatch(harness.open('session-a'))

    expect(harness.workers).toHaveLength(2)
    expect(harness.activeWorker(0).sent[0]?.envelope.payload.type).toBe(
      'session.open',
    )
  })

  test('Session ready 前的命令排队，ready 后按顺序发送', async () => {
    const harness = new SupervisorHarness()
    await harness.supervisor.dispatch(harness.open('session-a'))
    await harness.supervisor.dispatch(
      harness.command('session-a', {
        type: 'turn.start',
        prompt: '第一条',
      }),
    )
    await harness.supervisor.dispatch(
      harness.command('session-a', {
        type: 'turn.enqueue',
        prompt: '第二条',
      }),
    )

    const worker = harness.activeWorker(0)
    expect(worker.sent.map(item => item.envelope.payload.type)).toEqual([
      'session.open',
    ])

    worker.emitRuntimeEvent('session-a', {
      type: 'session.stateChanged',
      state: 'ready',
      runtimeSessionId: 'session-a-runtime',
    })

    expect(worker.sent.map(item => item.envelope.payload.type)).toEqual([
      'session.open',
      'turn.start',
      'turn.enqueue',
    ])
  })

  test('达到并发上限时新 Session 等待，已有 Worker 退出后自动接续', async () => {
    const harness = new SupervisorHarness(2)
    await harness.supervisor.dispatch(harness.open('session-a'))
    await harness.supervisor.dispatch(harness.open('session-b'))
    const workerA = harness.workerForSession('session-a')
    const workerB = harness.workerForSession('session-b')
    workerA.emitRuntimeEvent('session-a', {
      type: 'session.stateChanged',
      state: 'busy',
    })
    workerB.emitRuntimeEvent('session-b', {
      type: 'session.stateChanged',
      state: 'busy',
    })

    await harness.supervisor.dispatch(harness.open('session-c'))
    expect(
      harness.events.some(
        event =>
          event.sessionId === 'session-c' &&
          event.payload.type === 'session.stateChanged' &&
          event.payload.state === 'cold',
      ),
    ).toBe(true)

    workerA.exit(0)

    expect(
      harness.workers.some(worker =>
        worker.sent.some(
          message =>
            message.envelope.sessionId === 'session-c' &&
            message.envelope.payload.type === 'session.open',
        ),
      ),
    ).toBe(true)
  })

  test('空闲 Worker 超时后挂起，但忙碌 Worker 保持运行', async () => {
    const harness = new SupervisorHarness(2, 1_000)
    await harness.supervisor.dispatch(harness.open('session-a'))
    await harness.supervisor.dispatch(harness.open('session-b'))
    const workerA = harness.workerForSession('session-a')
    const workerB = harness.workerForSession('session-b')
    workerA.emitRuntimeEvent('session-a', {
      type: 'session.stateChanged',
      state: 'ready',
    })
    workerB.emitRuntimeEvent('session-b', {
      type: 'session.stateChanged',
      state: 'busy',
    })

    harness.now += 1_001
    harness.runIdleSweep()

    expect(workerA.killSignals).toContain('SIGTERM')
    expect(workerB.killSignals).not.toContain('SIGTERM')
    expect(
      harness.events.some(
        event =>
          event.sessionId === 'session-a' &&
          event.payload.type === 'session.stateChanged' &&
          event.payload.state === 'suspended',
      ),
    ).toBe(true)
  })

  test('崩溃恢复只重发 resume，不重放 Turn 命令', async () => {
    const harness = new SupervisorHarness()
    await harness.supervisor.dispatch(harness.open('session-a'))
    const worker = harness.activeWorker(0)
    worker.emitRuntimeEvent('session-a', {
      type: 'session.stateChanged',
      state: 'ready',
    })
    await harness.supervisor.dispatch(
      harness.command('session-a', {
        type: 'turn.start',
        prompt: '可能产生副作用',
      }),
    )

    worker.exit(1)
    expect(harness.timers[0]?.delayMs).toBe(500)
    harness.runTimer(0)

    const replacement = harness.workers.find(candidate =>
      candidate.sent.some(message =>
        message.envelope.requestId.startsWith('recovery-'),
      ),
    )
    expect(replacement).toBeDefined()
    expect(
      replacement!.sent.map(message => message.envelope.payload.type),
    ).toEqual(['session.resume'])
  })

  test('连续崩溃最多恢复三次，第四次标记为不可恢复', async () => {
    const harness = new SupervisorHarness()
    await harness.supervisor.dispatch(harness.open('session-a'))

    for (let crash = 0; crash < 4; crash++) {
      const current = harness.workers.findLast(worker =>
        worker.sent.some(message => message.envelope.sessionId === 'session-a'),
      )!
      current.exit(1)
      if (crash < 3) harness.runTimer(crash)
    }

    const crashes = harness.events.filter(
      event => event.payload.type === 'worker.crashed',
    )
    expect(crashes).toHaveLength(4)
    expect(
      crashes.map(event =>
        event.payload.type === 'worker.crashed'
          ? event.payload.recoverable
          : undefined,
      ),
    ).toEqual([true, true, true, false])
  })

  test('每个 Session 的 sequence 独立单调递增，连续一万条不重复', async () => {
    const harness = new SupervisorHarness()
    await harness.supervisor.dispatch(harness.open('session-a'))
    await harness.supervisor.dispatch(harness.open('session-b'))
    const workerA = harness.workerForSession('session-a')
    const workerB = harness.workerForSession('session-b')

    for (let index = 0; index < 10_000; index++) {
      workerA.emitRuntimeEvent('session-a', {
        type: 'runtime.progress',
        phase: `a-${index}`,
      })
      workerB.emitRuntimeEvent('session-b', {
        type: 'runtime.progress',
        phase: `b-${index}`,
      })
    }

    const sequencesA = harness.events
      .filter(event => event.sessionId === 'session-a')
      .map(event => event.sequence)
    const sequencesB = harness.events
      .filter(event => event.sessionId === 'session-b')
      .map(event => event.sequence)
    expect(sequencesA).toEqual(
      Array.from({ length: 10_000 }, (_, index) => index + 1),
    )
    expect(sequencesB).toEqual(
      Array.from({ length: 10_000 }, (_, index) => index + 1),
    )
  })

  test('shutdown 先发送 SIGTERM，超时后 SIGKILL，并停止空闲扫描', async () => {
    const harness = new SupervisorHarness()
    await harness.supervisor.dispatch(harness.open('session-a'))
    const active = harness.workers[0]!
    const prewarmed = harness.workers[1]!

    const shutdownPromise = harness.supervisor.shutdown()
    expect(active.killSignals).toEqual(['SIGTERM'])
    expect(prewarmed.killSignals).toEqual(['SIGTERM'])
    expect(harness.intervals[0]?.cleared).toBe(true)

    for (const timer of harness.timers) timer.callback()
    await shutdownPromise

    expect(active.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(prewarmed.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

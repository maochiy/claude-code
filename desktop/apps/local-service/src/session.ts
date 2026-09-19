import {
  isJsonValue,
  type AcceptedResult,
  type BackgroundTaskSnapshot,
  type CliLaunchSpec,
  type JsonValue,
  type PendingControlSnapshot,
  type SessionControlParams,
  type SessionInterruptParams,
  type SessionOpenParams,
  type SessionOpenResult,
  type SessionProcessState,
  type SessionRespondParams,
  type SessionRunState,
  type SessionSendParams,
  type SessionSnapshot,
  type TaskOutputResult,
} from '@proma/desktop-protocol'
import type { Subprocess } from 'bun'
import { stat } from 'node:fs/promises'
import { ServiceError, errorMessage } from './errors.ts'
import {
  SessionEventStore,
  type EventListener,
  type ReplayResult,
} from './event-store.ts'
import { LineDecoder } from './line-decoder.ts'

const STDERR_HISTORY_LIMIT = 200
const MAX_TASK_OUTPUT_CHUNK = 1024 * 1024
const TASK_STOP_GRACE_MS = 2_000
const GRACEFUL_STOP_MS = 2_000
const DEDUPLICATION_LIMIT = 2_000

interface QueuedRun {
  params: SessionSendParams
  runId: string
  messageUuid: string
}

interface PendingHostControl {
  requestId: string
  subtype: string
  runId?: string
}

interface SessionOptions {
  open: SessionOpenParams
  generation: number
  defaultCli?: CliLaunchSpec
  journalPath: string
  onEvent: EventListener
  now?: () => number
}

type IdleEvictionReason = 'idle_timeout' | 'idle_capacity'

export interface SessionEvictionState {
  lastActivityAt: number
  safeToEvict: boolean
  activeRun: boolean
  queuedRuns: number
  pendingControls: number
  runningTasks: number
}

interface CliRecord {
  [key: string]: JsonValue
}

type ManagedProcess = Subprocess<'pipe', 'pipe', 'pipe'>

function asRecord(value: JsonValue): CliRecord | null {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return null
  }
  return value
}

function stringField(record: CliRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function buildLaunch(
  params: SessionOpenParams,
  fallback?: CliLaunchSpec,
): CliLaunchSpec {
  const cli = params.cli ?? fallback
  if (!cli?.command) {
    throw new ServiceError(
      'CLI_NOT_CONFIGURED',
      '没有配置自有 CLI 的启动命令',
    )
  }
  if ((params.resumeSessionAt || params.forkSession) && !params.resumeSessionId) {
    throw new ServiceError(
      'INVALID_PARAMS',
      'resumeSessionAt/forkSession 必须与 resumeSessionId 一起使用',
    )
  }
  if (
    params.nativeSessionId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      params.nativeSessionId,
    )
  ) {
    throw new ServiceError(
      'INVALID_PARAMS',
      'nativeSessionId 必须是合法 UUID',
    )
  }
  const freshNativeSessionId = params.nativeSessionId ?? params.sessionId
  const argv = [
    ...cli.argv,
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--permission-prompt-tool',
    'stdio',
  ]
  if (params.resumeSessionId) {
    argv.push('--resume', params.resumeSessionId)
    if (params.resumeSessionAt) {
      argv.push('--resume-session-at', params.resumeSessionAt)
    }
    if (params.forkSession) {
      argv.push('--fork-session', '--session-id', freshNativeSessionId)
    }
  } else {
    argv.push('--session-id', freshNativeSessionId)
  }
  if (params.permissionMode) {
    argv.push('--permission-mode', params.permissionMode)
    if (params.permissionMode === 'bypassPermissions') {
      argv.push('--dangerously-skip-permissions')
    }
  }
  if (params.model) argv.push('--model', params.model)
  return { command: cli.command, argv, env: cli.env }
}

function launchFingerprint(params: SessionOpenParams, launch: CliLaunchSpec) {
  return JSON.stringify({
    cwd: params.cwd,
    nativeSessionId: params.nativeSessionId ?? null,
    resumeSessionId: params.resumeSessionId ?? null,
    resumeSessionAt: params.resumeSessionAt ?? null,
    forkSession: params.forkSession ?? false,
    permissionMode: params.permissionMode ?? null,
    model: params.model ?? null,
    command: launch.command,
    argv: launch.argv,
    env: launch.env ?? {},
  })
}

export function getSessionOpenFingerprint(
  params: SessionOpenParams,
  fallback?: CliLaunchSpec,
): string {
  return launchFingerprint(params, buildLaunch(params, fallback))
}

export class LocalCliSession {
  readonly sessionId: string
  readonly cwd: string
  readonly generation: number
  readonly events: SessionEventStore
  readonly fingerprint: string

  private readonly launch: CliLaunchSpec
  private readonly stdinSessionId: string
  private process: ManagedProcess | null = null
  private exitHandled: Promise<void> | null = null
  private state: SessionProcessState = 'starting'
  private queue: QueuedRun[] = []
  private activeRun: QueuedRun | null = null
  private pendingRunOutcome: SessionRunState | null = null
  private readonly completedRequests = new Map<string, AcceptedResult>()
  private readonly pendingHostControls = new Map<string, PendingHostControl>()
  private readonly pendingCliControls = new Map<
    string,
    PendingControlSnapshot
  >()
  private readonly tasks = new Map<string, BackgroundTaskSnapshot>()
  private readonly stderrHistory: string[] = []
  private readonly now: () => number
  private lastActivityAt: number
  private stopReason: IdleEvictionReason | undefined
  private stopPromise: Promise<void> | null = null

  constructor(private readonly options: SessionOptions) {
    this.sessionId = options.open.sessionId
    this.cwd = options.open.cwd
    this.generation = options.generation
    this.launch = buildLaunch(options.open, options.defaultCli)
    this.stdinSessionId =
      options.open.resumeSessionId && !options.open.forkSession
        ? options.open.resumeSessionId
        : (options.open.nativeSessionId ?? options.open.sessionId)
    this.fingerprint = launchFingerprint(options.open, this.launch)
    this.now = options.now ?? Date.now
    this.lastActivityAt = this.now()
    this.events = new SessionEventStore(
      this.sessionId,
      this.generation,
      undefined,
      options.journalPath,
    )
    this.events.subscribe(options.onEvent)
  }

  async start(): Promise<SessionOpenResult> {
    const cwdStat = await stat(this.cwd).catch(() => null)
    if (!cwdStat?.isDirectory()) {
      throw new ServiceError(
        'INVALID_CWD',
        `会话目录不存在或不是目录：${this.cwd}`,
      )
    }

    this.setProcessState('starting')
    try {
      this.process = Bun.spawn([this.launch.command, ...this.launch.argv], {
        cwd: this.cwd,
        // Main 已构造完整 clean env。显式 env 必须替换继承，避免把服务进程中的
        // Provider 凭据重新注入 CLI，导致模型路由串线。
        env: this.launch.env ?? process.env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      }) as ManagedProcess
    } catch (error) {
      this.setProcessState('crashed', { error: errorMessage(error) })
      throw new ServiceError('CLI_SPAWN_FAILED', errorMessage(error))
    }

    void this.consumeStdout(this.process.stdout)
    void this.consumeStderr(this.process.stderr)
    this.exitHandled = this.watchExit(this.process)
    return this.openResult()
  }

  openResult(): SessionOpenResult {
    return {
      sessionId: this.sessionId,
      generation: this.generation,
      pid: this.process?.pid ?? null,
      state: this.state,
    }
  }

  markAccessed(): void {
    this.touch()
  }

  getEvictionState(): SessionEvictionState {
    const runningTasks = [...this.tasks.values()].filter(
      task => task.state === 'running',
    ).length
    const pendingControls =
      this.pendingHostControls.size + this.pendingCliControls.size
    return {
      lastActivityAt: this.lastActivityAt,
      safeToEvict:
        (this.state === 'ready' || this.state === 'idle') &&
        this.activeRun === null &&
        this.queue.length === 0 &&
        pendingControls === 0 &&
        runningTasks === 0,
      activeRun: this.activeRun !== null,
      queuedRuns: this.queue.length,
      pendingControls,
      runningTasks,
    }
  }

  send(params: SessionSendParams): AcceptedResult {
    const previous = this.completedRequests.get(params.requestId)
    if (previous) return previous
    this.assertWritable()
    this.touch()
    const runId = params.runId ?? crypto.randomUUID()
    const queued: QueuedRun = {
      params,
      runId,
      messageUuid: crypto.randomUUID(),
    }
    const accepted: AcceptedResult = {
      accepted: true,
      requestId: params.requestId,
      runId,
    }
    this.rememberAccepted(params.requestId, accepted)
    if (params.interrupt) {
      this.queue.unshift(queued)
    } else {
      this.queue.push(queued)
    }
    this.emitRunState(queued, 'queued')
    if (params.interrupt && this.activeRun) {
      this.pendingRunOutcome = 'interrupted'
      this.sendControlInternal(
        'interrupt:' + params.requestId,
        'interrupt',
        {},
        this.activeRun.runId,
      )
    } else {
      this.dispatchNext()
    }
    return accepted
  }

  interrupt(params: SessionInterruptParams): AcceptedResult {
    const previous = this.completedRequests.get(params.requestId)
    if (previous) return previous
    this.assertWritable()
    this.touch()
    if (params.runId && this.activeRun?.runId !== params.runId) {
      const index = this.queue.findIndex(run => run.runId === params.runId)
      if (index >= 0) {
        const [cancelled] = this.queue.splice(index, 1)
        if (cancelled) this.emitRunState(cancelled, 'interrupted')
      }
    } else if (this.activeRun) {
      this.pendingRunOutcome = 'interrupted'
      this.sendControlInternal(
        params.requestId,
        'interrupt',
        {},
        this.activeRun.runId,
      )
    }
    const accepted: AcceptedResult = {
      accepted: true,
      requestId: params.requestId,
      ...(params.runId === undefined ? {} : { runId: params.runId }),
    }
    this.rememberAccepted(params.requestId, accepted)
    return accepted
  }

  control(params: SessionControlParams): AcceptedResult {
    const previous = this.completedRequests.get(params.requestId)
    if (previous) return previous
    this.assertWritable()
    this.touch()
    if (params.subtype === 'cancel_queued') {
      const runId = params.payload?.runId
      const queuedRequestId = params.payload?.requestId
      const index = this.queue.findIndex(
        run =>
          (typeof runId === 'string' && run.runId === runId) ||
          (typeof queuedRequestId === 'string' &&
            run.params.requestId === queuedRequestId),
      )
      if (index >= 0) {
        const [cancelled] = this.queue.splice(index, 1)
        if (cancelled) this.emitRunState(cancelled, 'interrupted')
      }
    } else {
      this.sendControlInternal(
        params.requestId,
        params.subtype,
        params.payload ?? {},
        this.activeRun?.runId,
      )
    }
    const accepted: AcceptedResult = {
      accepted: true,
      requestId: params.requestId,
      ...(this.activeRun ? { runId: this.activeRun.runId } : {}),
    }
    this.rememberAccepted(params.requestId, accepted)
    return accepted
  }

  respond(params: SessionRespondParams): AcceptedResult {
    const previous = this.completedRequests.get(params.requestId)
    if (previous) return previous
    this.assertWritable()
    this.touch()
    if (!this.pendingCliControls.has(params.cliRequestId)) {
      throw new ServiceError(
        'CONTROL_NOT_PENDING',
        `控制请求已结算或不存在：${params.cliRequestId}`,
      )
    }
    const line: JsonValue = params.error
      ? {
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: params.cliRequestId,
            error: params.error,
          },
        }
      : {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: params.cliRequestId,
            response: params.response ?? {},
          },
        }
    this.writeLine(line)
    this.pendingCliControls.delete(params.cliRequestId)
    this.events.append({
      source: 'service',
      kind: 'control_resolved',
      requestId: params.requestId,
      runId: this.activeRun?.runId,
      payload: {
        direction: 'cli_to_host',
        cliRequestId: params.cliRequestId,
        outcome: params.error ? 'error' : 'success',
      },
    })
    const accepted: AcceptedResult = {
      accepted: true,
      requestId: params.requestId,
      ...(this.activeRun ? { runId: this.activeRun.runId } : {}),
    }
    this.rememberAccepted(params.requestId, accepted)
    return accepted
  }

  stopTask(taskId: string, requestId: string): AcceptedResult {
    const task = this.tasks.get(taskId)
    if (!task) {
      throw new ServiceError('TASK_NOT_FOUND', `后台任务不存在：${taskId}`)
    }
    return this.control({
      sessionId: this.sessionId,
      requestId,
      subtype: 'stop_task',
      payload: { task_id: taskId },
    })
  }

  async readTaskOutput(
    taskId: string,
    offset = 0,
    requestedLimit = 64 * 1024,
  ): Promise<TaskOutputResult> {
    const task = this.tasks.get(taskId)
    if (!task) {
      throw new ServiceError('TASK_NOT_FOUND', `后台任务不存在：${taskId}`)
    }
    if (!task.outputFile) {
      return { taskId, offset, nextOffset: offset, eof: true, content: '' }
    }
    const file = Bun.file(task.outputFile)
    if (!(await file.exists())) {
      throw new ServiceError(
        'TASK_OUTPUT_NOT_FOUND',
        `后台任务输出文件不存在：${taskId}`,
      )
    }
    const safeOffset = Math.max(0, Math.floor(offset))
    const limit = Math.min(
      MAX_TASK_OUTPUT_CHUNK,
      Math.max(1, Math.floor(requestedLimit)),
    )
    const end = Math.min(file.size, safeOffset + limit)
    const content = await file.slice(safeOffset, end).text()
    return {
      taskId,
      offset: safeOffset,
      nextOffset: end,
      eof: end >= file.size,
      content,
    }
  }

  async snapshot(afterSeq = 0): Promise<SessionSnapshot> {
    const replay = await this.events.replay(afterSeq)
    return {
      sessionId: this.sessionId,
      generation: this.generation,
      seq: this.events.currentSeq,
      state: this.state,
      cwd: this.cwd,
      pid: this.process?.pid ?? null,
      ...(this.activeRun ? { activeRunId: this.activeRun.runId } : {}),
      pendingControls: [...this.pendingCliControls.values()],
      tasks: [...this.tasks.values()],
      events: replay.events,
      replay: {
        requestedAfterSeq: replay.requestedAfterSeq,
        oldestAvailableSeq: replay.oldestAvailableSeq,
        currentSeq: replay.currentSeq,
        truncated: replay.truncated,
      },
    }
  }

  replay(afterSeq = 0): Promise<ReplayResult> {
    return this.events.replay(afterSeq)
  }

  emitReplayReset(replay: ReplayResult) {
    return this.events.append({
      source: 'service',
      kind: 'replay_reset',
      payload: {
        requestedAfterSeq: replay.requestedAfterSeq,
        oldestAvailableSeq: replay.oldestAvailableSeq,
        currentSeq: replay.currentSeq,
        state: this.state,
        activeRunId: this.activeRun?.runId ?? null,
        pendingControls: [...this.pendingCliControls.values()] as unknown as JsonValue,
        tasks: [...this.tasks.values()] as unknown as JsonValue,
      },
    })
  }

  async stop(reason?: IdleEvictionReason): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopReason = reason
    this.stopPromise = this.stopProcess()
    return this.stopPromise
  }

  private async stopProcess(): Promise<void> {
    if (!this.process) {
      await this.events.close()
      return
    }
    this.setProcessState('stopping', {
      ...(this.stopReason ? { reason: this.stopReason } : {}),
    })
    const child = this.process
    const runningTasks = [...this.tasks.values()].filter(
      task => task.state === 'running',
    )
    for (const task of runningTasks) {
      this.sendControlInternal(
        `shutdown-stop-${task.taskId}`,
        'stop_task',
        { task_id: task.taskId },
      )
    }
    if (runningTasks.length > 0) {
      const stopDeadline = Date.now() + TASK_STOP_GRACE_MS
      while (
        Date.now() < stopDeadline &&
        [...this.tasks.values()].some(task => task.state === 'running')
      ) {
        await Bun.sleep(25)
      }
    }
    child.stdin.end()
    const exited = child.exited.then(() => true)
    const graceful = await Promise.race([
      exited,
      Bun.sleep(GRACEFUL_STOP_MS).then(() => false),
    ])
    if (!graceful) {
      child.kill()
      await child.exited.catch(() => undefined)
    }
    await this.exitHandled
    await this.events.close()
  }

  private touch(): void {
    this.lastActivityAt = this.now()
  }

  private assertWritable(): void {
    if (
      !this.process ||
      this.state === 'stopping' ||
      this.state === 'stopped' ||
      this.state === 'crashed'
    ) {
      throw new ServiceError(
        'SESSION_NOT_WRITABLE',
        `会话当前不可写：${this.sessionId}`,
      )
    }
  }

  private rememberAccepted(requestId: string, result: AcceptedResult): void {
    this.completedRequests.set(requestId, result)
    if (this.completedRequests.size <= DEDUPLICATION_LIMIT) return
    const oldest = this.completedRequests.keys().next().value
    if (oldest !== undefined) this.completedRequests.delete(oldest)
  }

  private dispatchNext(): void {
    if (this.activeRun || this.queue.length === 0) return
    if (
      this.state === 'stopping' ||
      this.state === 'stopped' ||
      this.state === 'crashed'
    ) {
      return
    }
    const next = this.queue.shift()
    if (!next) return
    this.activeRun = next
    this.pendingRunOutcome = null
    this.writeLine({
      type: 'user',
      uuid: next.messageUuid,
      session_id: this.stdinSessionId,
      message: { role: 'user', content: next.params.content },
      parent_tool_use_id: null,
      ...(next.params.priority ? { priority: next.params.priority } : {}),
    })
    this.setProcessState('running')
    this.emitRunState(next, 'running')
  }

  private completeActiveRun(
    outcome: SessionRunState,
    dispatchQueued = true,
  ): void {
    const active = this.activeRun
    if (!active) return
    this.emitRunState(active, outcome)
    this.activeRun = null
    this.pendingRunOutcome = null
    if (dispatchQueued) this.dispatchNext()
  }

  private emitRunState(run: QueuedRun, state: SessionRunState): void {
    this.events.append({
      source: 'service',
      kind: 'run_state',
      requestId: run.params.requestId,
      runId: run.runId,
      payload: { state },
    })
  }

  private setProcessState(
    state: SessionProcessState,
    extra: Record<string, JsonValue> = {},
  ): void {
    this.state = state
    this.events.append({
      source: 'service',
      kind: 'process_state',
      runId: this.activeRun?.runId,
      payload: { state, ...extra },
    })
  }

  private sendControlInternal(
    requestId: string,
    subtype: string,
    payload: Record<string, JsonValue>,
    runId?: string,
  ): void {
    const cliRequestId = crypto.randomUUID()
    this.pendingHostControls.set(cliRequestId, {
      requestId,
      subtype,
      ...(runId === undefined ? {} : { runId }),
    })
    this.writeLine({
      type: 'control_request',
      request_id: cliRequestId,
      request: { subtype, ...payload },
    })
    this.events.append({
      source: 'service',
      kind: 'control_pending',
      requestId,
      ...(runId === undefined ? {} : { runId }),
      payload: {
        direction: 'host_to_cli',
        cliRequestId,
        subtype,
      },
    })
  }

  private writeLine(value: JsonValue): void {
    if (!this.process) {
      throw new ServiceError('SESSION_NOT_STARTED', 'CLI 进程尚未启动')
    }
    this.process.stdin.write(`${JSON.stringify(value)}\n`)
    this.process.stdin.flush()
  }

  private async consumeStdout(
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const decoder = new LineDecoder()
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.push(value)) this.consumeStdoutLine(line)
      }
      for (const line of decoder.finish()) this.consumeStdoutLine(line)
    } catch (error) {
      this.emitServiceError('CLI_STDOUT_FAILED', errorMessage(error))
    } finally {
      reader.releaseLock()
    }
  }

  private consumeStdoutLine(line: string): void {
    if (!line) return
    this.touch()
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.emitServiceError('CLI_INVALID_NDJSON', 'CLI stdout 包含非 JSON 行', {
        line: line.slice(0, 2_000),
      })
      return
    }
    if (!isJsonValue(raw)) {
      this.emitServiceError('CLI_INVALID_JSON', 'CLI stdout 不是合法 JSON 值')
      return
    }
    const message = asRecord(raw)
    if (!message) {
      this.emitServiceError('CLI_INVALID_MESSAGE', 'CLI stdout 消息必须是对象')
      return
    }
    const messageType = stringField(message, 'type')
    const subtype = stringField(message, 'subtype')

    this.events.append({
      source: 'cli',
      kind: 'cli_message',
      runId: this.activeRun?.runId,
      payload: raw,
    })

    if (messageType === 'system' && subtype === 'init') {
      this.setProcessState(this.activeRun ? 'running' : 'ready')
    } else if (messageType === 'system') {
      this.handleSystemMessage(message)
    } else if (messageType === 'control_request') {
      this.handleCliControlRequest(message)
    } else if (messageType === 'control_cancel_request') {
      const cliRequestId = stringField(message, 'request_id')
      if (cliRequestId) {
        const pending = this.pendingCliControls.get(cliRequestId)
        this.pendingCliControls.delete(cliRequestId)
        this.events.append({
          source: 'cli',
          kind: 'control_resolved',
          runId: this.activeRun?.runId,
          payload: {
            direction: 'cli_to_host',
            cliRequestId,
            ...(pending ? { subtype: pending.subtype } : {}),
            outcome: 'cancelled',
          },
        })
      }
    } else if (messageType === 'control_response') {
      this.handleControlResponse(message)
    } else if (messageType === 'result') {
      // 真实 CLI 将 result 作为前台轮次终态，不保证随后再发送
      // session_state_changed=idle。先记录 result（上方事件仍绑定旧 runId），
      // 再结算当前轮次并派发队列；后台任务继续由独立 task 事件管理。
      const outcome =
        this.pendingRunOutcome ??
        (subtype === 'success' ? 'completed' : 'failed')
      this.completeActiveRun(outcome)
      if (!this.activeRun) this.setProcessState('idle')
    }
  }

  private handleSystemMessage(message: CliRecord): void {
    const subtype = stringField(message, 'subtype')
    if (subtype === 'session_state_changed') {
      const state = stringField(message, 'state')
      if (state === 'requires_action') {
        this.setProcessState('requires_action')
        if (this.activeRun) this.emitRunState(this.activeRun, 'requires_action')
      } else if (state === 'running') {
        this.setProcessState('running')
      } else if (state === 'idle') {
        // 兼容仍发送 idle 的旧 CLI。result 已经结算并可能派发下一轮时，
        // 迟到的 idle 不能误结算新 run。
        if (!this.activeRun || this.pendingRunOutcome !== null) {
          this.setProcessState('idle')
          this.completeActiveRun(this.pendingRunOutcome ?? 'completed')
        }
      }
      return
    }
    if (subtype === 'task_started') {
      const taskId = stringField(message, 'task_id')
      if (!taskId) return
      this.updateTask(taskId, {
        state: 'running',
        toolUseId: stringField(message, 'tool_use_id'),
        description: stringField(message, 'description'),
      })
      return
    }
    if (subtype === 'task_progress') {
      const taskId = stringField(message, 'task_id')
      if (!taskId) return
      this.updateTask(taskId, {
        state: 'running',
        description: stringField(message, 'description'),
        summary: stringField(message, 'summary'),
        usage: message.usage,
      })
      return
    }
    if (subtype === 'task_notification') {
      const taskId = stringField(message, 'task_id')
      const status = stringField(message, 'status')
      if (!taskId) return
      this.updateTask(taskId, {
        state:
          status === 'failed'
            ? 'failed'
            : status === 'stopped' || status === 'killed'
              ? 'stopped'
              : 'completed',
        summary: stringField(message, 'summary'),
        outputFile: stringField(message, 'output_file'),
        usage: message.usage,
      })
    }
  }

  private updateTask(
    taskId: string,
    patch: {
      state: BackgroundTaskSnapshot['state']
      toolUseId?: string
      description?: string
      summary?: string
      outputFile?: string
      usage?: JsonValue
    },
  ): void {
    const previous = this.tasks.get(taskId)
    const task: BackgroundTaskSnapshot = {
      taskId,
      state: patch.state,
      ...(previous?.toolUseId || patch.toolUseId
        ? { toolUseId: patch.toolUseId ?? previous?.toolUseId }
        : {}),
      ...(previous?.description || patch.description
        ? { description: patch.description ?? previous?.description }
        : {}),
      ...(previous?.summary || patch.summary
        ? { summary: patch.summary ?? previous?.summary }
        : {}),
      ...(previous?.outputFile || patch.outputFile
        ? { outputFile: patch.outputFile ?? previous?.outputFile }
        : {}),
      ...(patch.usage !== undefined || previous?.usage !== undefined
        ? { usage: patch.usage ?? previous?.usage ?? null }
        : {}),
      updatedAt: Date.now(),
    }
    this.tasks.set(taskId, task)
    this.events.append({
      source: 'cli',
      kind: 'task_state',
      runId: this.activeRun?.runId,
      payload: task as unknown as JsonValue,
    })
  }

  private handleCliControlRequest(message: CliRecord): void {
    const cliRequestId = stringField(message, 'request_id')
    const request = message.request
    const requestRecord = request === undefined ? null : asRecord(request)
    const subtype = requestRecord
      ? stringField(requestRecord, 'subtype')
      : undefined
    if (!cliRequestId || !request || !subtype) return
    const pending: PendingControlSnapshot = {
      cliRequestId,
      subtype,
      request,
      createdAt: Date.now(),
    }
    this.pendingCliControls.set(cliRequestId, pending)
    this.events.append({
      source: 'cli',
      kind: 'control_pending',
      runId: this.activeRun?.runId,
      payload: {
        direction: 'cli_to_host',
        cliRequestId,
        subtype,
        request,
      },
    })
    if (subtype === 'can_use_tool') {
      this.setProcessState('requires_action')
      if (this.activeRun) this.emitRunState(this.activeRun, 'requires_action')
    }
  }

  private handleControlResponse(message: CliRecord): void {
    const response = message.response
    const responseRecord = response === undefined ? null : asRecord(response)
    const cliRequestId = responseRecord
      ? stringField(responseRecord, 'request_id')
      : undefined
    if (!cliRequestId) return
    const pending = this.pendingHostControls.get(cliRequestId)
    if (!pending) return
    this.pendingHostControls.delete(cliRequestId)
    this.events.append({
      source: 'cli',
      kind: 'control_resolved',
      requestId: pending.requestId,
      ...(pending.runId === undefined ? {} : { runId: pending.runId }),
      payload: {
        direction: 'host_to_cli',
        cliRequestId,
        subtype: pending.subtype,
        ...(response === undefined ? {} : { response }),
      },
    })
  }

  private async consumeStderr(
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const decoder = new LineDecoder()
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.push(value)) this.consumeStderrLine(line)
      }
      for (const line of decoder.finish()) this.consumeStderrLine(line)
    } catch (error) {
      this.emitServiceError('CLI_STDERR_FAILED', errorMessage(error))
    } finally {
      reader.releaseLock()
    }
  }

  private consumeStderrLine(line: string): void {
    if (!line) return
    this.stderrHistory.push(line)
    if (this.stderrHistory.length > STDERR_HISTORY_LIMIT) {
      this.stderrHistory.shift()
    }
    this.events.append({
      source: 'cli',
      kind: 'cli_stderr',
      runId: this.activeRun?.runId,
      payload: { line },
    })
  }

  private async watchExit(
    child: ManagedProcess,
  ): Promise<void> {
    const exitCode = await child.exited
    const expected = this.state === 'stopping'
    this.process = null
    if (this.activeRun) {
      // 进程已经退出，不能在结算当前轮次时继续向已关闭的 stdin 派发队列。
      this.completeActiveRun(expected ? 'interrupted' : 'failed', false)
    }
    for (const queued of this.queue.splice(0)) {
      this.emitRunState(queued, 'failed')
    }
    this.setProcessState(expected ? 'stopped' : exitCode === 0 ? 'stopped' : 'crashed', {
      exitCode,
      stderrTail: this.stderrHistory.slice(-20),
      ...(this.stopReason ? { reason: this.stopReason } : {}),
    })
  }

  private emitServiceError(
    code: string,
    message: string,
    details?: JsonValue,
  ): void {
    this.events.append({
      source: 'service',
      kind: 'service_error',
      runId: this.activeRun?.runId,
      payload: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    })
  }
}

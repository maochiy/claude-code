import { readNativeTranscript } from './transcript-reader'
import { buildImportedHistoryContext } from './history-context'
import { SessionPreparationGate } from './session-preparation'
import { getCcbUserConfigDir } from '../ccb-runtime/user-config'
import { projectLocalCliTasks, projectLocalCliTodos, projectLocalCliTaskTranscript } from './task-projection'
import { randomUUID } from 'node:crypto'
import type { AgentProviderAdapter, AgentQueryInput, AgentRuntimeSessionOperationInput,
  AgentRuntimeForkResult, AgentRuntimeRewindResult, AgentRuntimeClearResult, SDKMessage, SDKUserMessageInput,
  SendQueuedMessageOptions, ThinkingConfig, ThinkingEffortLevel } from '@proma/shared'
import type { LocalCliAgentQueryOptions } from './query-options'
import type { LocalServiceClient, LocalServiceEvent } from './client'
import { localServiceSupervisor } from './supervisor'
import { createCcbPartialAssistantState, applyCcbPartialAssistantEvent, annotateCcbFinalAssistantMessage,
  type CcbPartialAssistantState } from '../ccb-runtime/ccb-partial-assistant'
import { normalizeCcbMessage } from '../ccb-runtime/ccb-assistant-message-normalization'
import { recordInitializedAgentRuntimeModelCatalog } from '../ccb-runtime/model-catalog-service'
import { parseLocalCliControlResolution } from './control-response'
import { buildLocalCliProviderSettings } from './provider-configuration'
import { buildDesktopCliPreferences } from './desktop-preferences'
import { getSettings } from '../settings-service'
import { resolveAdditionalDirectories } from './additional-directories'
import { availableBuiltinTools, normalizeToolPolicy, toolPolicyAllows } from './tool-policy'
import { TaskOutputReader } from './task-output-reader'
import { parseReplayResetSnapshot } from './replay-recovery'
import { materializeLocalCliMcpServers, releaseLocalCliMcpServers } from './mcp-transport'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { buildLocalCliProxyEnvironment } from './proxy-environment'

class MessageQueue {
  private messages: SDKMessage[] = []
  private waiting?: () => void
  private ended = false
  private failure?: Error
  push(message: SDKMessage): void { this.messages.push(message); this.waiting?.() }
  end(error?: Error): void { this.ended = true; this.failure = error; this.waiting?.() }
  async *read(): AsyncGenerator<SDKMessage> {
    while (true) {
      while (this.messages.length) yield this.messages.shift()!
      if (this.ended) { if (this.failure) throw this.failure; return }
      await new Promise<void>((resolve) => { this.waiting = resolve })
      this.waiting = undefined
    }
  }
}

interface Session {
  options: LocalCliAgentQueryOptions
  queue?: MessageQueue
  partial: CcbPartialAssistantState
  unsubscribe: () => void
  controller: AbortController
  runId?: string
  fingerprint: string
  nativeSessionId?: string
  controls: Set<string>
  controlSignals: Map<string, AbortController>
  activeTasks: Set<string>
  ready: boolean
  outputReader: TaskOutputReader
  todos: import('@proma/shared').AgentRuntimeTodoItem[]
  configuration: Record<string, unknown>
  pendingControls: Map<string, PendingControl>
  queuedRuns: Map<string, PendingQueuedRun>
  terminalWaiters: Map<string, Set<RunTerminalWaiter>>
  recoveringRunIds: Set<string>
  replayRecovery?: Promise<void>
  replayRecoveryError?: Error
}

interface PendingControl {
  subtype: string
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  settled: Promise<void>
  settle: () => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingQueuedRun {
  started: boolean
  resolve: () => void
  reject: (error: Error) => void
}

interface RunTerminalWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'interrupted'])
const PREPARATION_COMPATIBLE_CONTROL_SUBTYPES = new Set([
  'get_context_usage',
  'get_tasks',
  'set_skill_directories',
])

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 长连接承载后台生命周期，query 迭代器只承载当前前台轮次。 */
export class LocalCliRuntimeAdapter implements AgentProviderAdapter {
  private readonly sessions = new Map<string, Session>()
  private readonly preparation = new SessionPreparationGate()
  onBackgroundMessage?: (sessionId: string, message: SDKMessage) => void

  hasSession(sessionId: string): boolean { return this.sessions.get(sessionId)?.ready === true }

  async prepareSession(input: AgentRuntimeSessionOperationInput & { channelId?: string }): Promise<void> {
    await this.ensureSession({ ...input, prompt: '', resumeSessionId: input.runtimeSessionId || undefined,
      sdkPermissionMode: input.permissionMode })
  }

  private async ensureSession(options: LocalCliAgentQueryOptions): Promise<Session> {
    return this.preparation.run(options.sessionId, () => this.prepareSessionUnlocked(options))
  }

  private async prepareSessionUnlocked(options: LocalCliAgentQueryOptions): Promise<Session> {
    const client = await localServiceSupervisor.getClient()
    const additionalDirectories = resolveAdditionalDirectories(options.additionalDirectories, options.cwd)
    const proxyEnvironment = buildLocalCliProxyEnvironment(options.env ?? {}, await getEffectiveProxyUrl())
    const preferences = buildDesktopCliPreferences(getSettings())
    const fingerprint = JSON.stringify([options.cwd, options.channelId, options.modelRoute?.routeRevision,
      options.modelRoute?.credentialRevision, options.mcpServers, additionalDirectories, options.systemPrompt,
      options.availableBuiltinTools, options.strictMcpConfig, options.toolPolicy, proxyEnvironment, preferences])
    let session = this.sessions.get(options.sessionId)
    if (session && !session.ready) {
      options = { ...options, resumeSessionId: session.nativeSessionId || options.resumeSessionId }
      await this.closeSession(options.sessionId)
      session = undefined
    }
    if (session && fingerprint !== session.fingerprint) {
      if (session.queue || session.queuedRuns.size > 0 || session.controlSignals.size > 0 || session.activeTasks.size > 0) {
        throw new Error('执行或控制请求处理中，不能切换目录或渠道')
      }
      await this.awaitPreparationCompatibleControls(session)
      if (this.sessions.get(options.sessionId) !== session) {
        return this.prepareSessionUnlocked(options)
      }
      if (session.queue || session.queuedRuns.size > 0 || session.pendingControls.size > 0
        || session.controlSignals.size > 0 || session.activeTasks.size > 0) {
        throw new Error('执行或控制请求处理中，不能切换目录或渠道')
      }
      options = { ...options, resumeSessionId: session.nativeSessionId || options.resumeSessionId }
      await this.closeSession(options.sessionId)
      session = undefined
    }
    if (session) {
      const previous = session.options
      if (previous.sdkPermissionMode !== options.sdkPermissionMode) {
        await this.setPermissionMode(options.sessionId, options.sdkPermissionMode ?? 'default')
      }
      await this.updateRuntimeConfig(options.sessionId, {
        ...(previous.model !== options.model ? { model: options.model } : {}),
        ...(JSON.stringify(previous.thinkingConfig) !== JSON.stringify(options.thinkingConfig)
          ? { thinkingConfig: options.thinkingConfig ?? null }
          : {}),
        ...(previous.effortLevel !== options.effortLevel
          ? { effortLevel: options.effortLevel ?? null }
          : {}),
      })
      if (JSON.stringify(previous.additionalSkillDirectories ?? []) !== JSON.stringify(options.additionalSkillDirectories ?? [])) {
        await this.refreshSkillCatalog(session, options.additionalSkillDirectories ?? [])
      }
      if (options.autoCompactEnabled !== undefined && previous.autoCompactEnabled !== options.autoCompactEnabled) {
        await this.setAutoCompact(options.sessionId, options.autoCompactEnabled)
      }
      session.options = options
      return session
    }
    const command = localServiceSupervisor.getCliCommand()
    const argv = [...command.argv, '--include-hook-events']
    const toolPolicy = normalizeToolPolicy(options.toolPolicy)
    const builtinTools = options.availableBuiltinTools ?? availableBuiltinTools(toolPolicy)
    const strictMcpConfig = options.strictMcpConfig || toolPolicy?.allowedTools !== undefined
    if (additionalDirectories.length) argv.push('--add-dir', ...additionalDirectories)
    const cliSettings = {
      ...preferences.settings,
      ...(options.providerConfiguration ? buildLocalCliProviderSettings(options.providerConfiguration) : {}),
    }
    if (Object.keys(cliSettings).length) argv.push('--settings', JSON.stringify(cliSettings))
    const systemPrompt = [options.systemPrompt, preferences.systemPrompt, !options.resumeSessionId ? buildImportedHistoryContext(options.historyMessages) : ''].filter(Boolean).join('\n\n')
    if (systemPrompt) argv.push('--append-system-prompt', systemPrompt)
    if (builtinTools !== undefined) argv.push('--tools', builtinTools.join(','))
    if (strictMcpConfig) argv.push('--strict-mcp-config')
    if (options.maxTurns) argv.push('--max-turns', String(options.maxTurns))
    if (options.maxBudgetUsd) argv.push('--max-budget-usd', String(options.maxBudgetUsd))
    if (options.fallbackModel) argv.push('--fallback-model', options.fallbackModel)
    if (toolPolicy?.disallowedTools?.length) argv.push('--disallowedTools', ...toolPolicy.disallowedTools)
    const env: Record<string, string> = { ...Object.fromEntries(Object.entries(options.env || {}).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ...proxyEnvironment,
      ...(toolPolicy ? { XCODES_TOOL_POLICY_JSON: JSON.stringify(toolPolicy) } : {}),
      ...preferences.environment }
    if (!env.CLAUDE_CONFIG_DIR && process.env.XCODES_DATA_ROOT) env.CLAUDE_CONFIG_DIR = getCcbUserConfigDir()
    const next: Session = { options, partial: createCcbPartialAssistantState(), unsubscribe: () => {},
      controller: new AbortController(), fingerprint, controls: new Set(), configuration: {}, pendingControls: new Map(),
      queuedRuns: new Map(), terminalWaiters: new Map(), controlSignals: new Map(), activeTasks: new Set(),
      recoveringRunIds: new Set(), ready: false, todos: [], outputReader: new TaskOutputReader() }
    this.sessions.set(options.sessionId, next)
    const unsubscribeEvents = client.subscribe((event) => {
      if (event.sessionId === options.sessionId) this.receive(client, next, event)
    })
    const unsubscribeFailure = client.subscribeFailure(error => this.failSession(next, error))
    next.unsubscribe = () => { unsubscribeEvents(); unsubscribeFailure() }
    try {
      if (options.mcpServers || strictMcpConfig) {
        const mcpServers = await materializeLocalCliMcpServers(options.sessionId, options.mcpServers)
        argv.push('--mcp-config', JSON.stringify({ mcpServers }))
      }
      await client.request('session.open', { sessionId: options.sessionId, cwd: options.cwd,
        nativeSessionId: options.nativeSessionId,
        resumeSessionId: options.resumeSessionId, resumeSessionAt: options.resumeSessionAt,
        forkSession: options.forkSession, permissionMode: options.sdkPermissionMode || 'default', model: options.model,
        cli: { ...command, argv, env } })
      next.configuration = await this.control(options.sessionId, 'initialize', {
        additionalSkillDirectories: options.additionalSkillDirectories ?? [],
      })
      if (options.channelId) {
        recordInitializedAgentRuntimeModelCatalog(options.channelId, next.configuration, options.model)
      }
      await this.updateRuntimeConfig(options.sessionId, {
        model: options.model,
        thinkingConfig: options.thinkingConfig,
        effortLevel: options.effortLevel,
      })
      if (options.autoCompactEnabled !== undefined) {
        await this.setAutoCompact(options.sessionId, options.autoCompactEnabled)
      }
      next.ready = true
      return next
    } catch (error) {
      next.unsubscribe(); next.controller.abort(); this.sessions.delete(options.sessionId)
      await client.request('session.close', { sessionId: options.sessionId }).catch(() => {})
      await releaseLocalCliMcpServers(options.sessionId)
      throw error
    }
  }

  private async awaitPreparationCompatibleControls(session: Session): Promise<void> {
    while (session.pendingControls.size > 0) {
      const pending = [...session.pendingControls.values()]
      if (pending.some(control => !PREPARATION_COMPATIBLE_CONTROL_SUBTYPES.has(control.subtype))) {
        throw new Error('执行或控制请求处理中，不能切换目录或渠道')
      }
      await Promise.all(pending.map(control => control.settled))
    }
  }

  private receive(client: LocalServiceClient, session: Session, event: LocalServiceEvent): void {
    if (event.kind === 'control_pending') {
      if (event.payload.direction === 'cli_to_host') {
        void this.respond(client, session, event).catch(() => {})
      }
      return
    }
    if (event.kind === 'control_resolved') {
      if (event.payload.direction === 'cli_to_host') {
        const requestId = String(event.payload.cliRequestId || '')
        if (event.payload.outcome === 'cancelled') session.controlSignals.get(requestId)?.abort()
        session.controlSignals.delete(requestId)
        session.controls.delete(requestId)
        return
      }
      const resolution = parseLocalCliControlResolution(event)
      const pending = resolution
        ? session.pendingControls.get(resolution.requestId)
        : undefined
      if (!resolution || !pending) return
      session.pendingControls.delete(resolution.requestId)
      clearTimeout(pending.timer)
      if (resolution.error) pending.reject(resolution.error)
      else pending.resolve(resolution.result ?? {})
      pending.settle()
      return
    }
    if (event.kind === 'run_state') {
      const state = typeof event.payload.state === 'string' ? event.payload.state : ''
      const runId = event.runId
      if (!runId) return
      const queued = session.queuedRuns.get(runId)
      if (state === 'running' && queued && !queued.started) {
        queued.started = true
        queued.resolve()
      }
      if (TERMINAL_RUN_STATES.has(state)) {
        this.settleRunTerminal(session, runId, state, session.recoveringRunIds.has(runId))
      }
      return
    }
    if (event.kind === 'task_state') {
      const taskId = String(event.payload.taskId || '')
      if (taskId && event.payload.state === 'running') session.activeTasks.add(taskId)
      else session.activeTasks.delete(taskId)
      return
    }
    if (event.kind === 'replay_reset') {
      this.startReplayRecovery(client, session, event)
      return
    }
    if (event.kind === 'process_state' && ['idle_timeout', 'idle_capacity'].includes(String(event.payload.reason))) {
      session.ready = false
      if (event.payload.state === 'stopped') void releaseLocalCliMcpServers(session.options.sessionId).catch(() => {})
      return
    }
    if (event.kind === 'service_error' || (event.kind === 'process_state' && ['crashed', 'exited', 'stopped'].includes(String(event.payload.state)))) {
      const error = new Error(String(event.payload.message || 'CLI 进程已退出'))
      this.failSession(session, error)
      return
    }
    if (event.kind !== 'cli_message') return
    const raw = record(event.payload.message || event.payload)
    if (typeof raw.type !== 'string') return
    if (raw.type === 'task_state') {
      session.todos = projectLocalCliTodos(raw.tasks)
      session.options.onNativeMessage?.({ ...raw, type: 'task_state', _createdAt: event.timestamp,
        _runtimeGeneration: event.generation, _runtimeSequence: event.seq })
      void this.getExecutionGraph(session.options.sessionId).then(graph => {
        this.onBackgroundMessage?.(session.options.sessionId, { type: 'runtime_execution_graph', graph })
      }).catch(() => {})
      return
    }
    if (typeof raw.session_id === 'string' && raw.session_id) {
      session.nativeSessionId = raw.session_id
      session.options.onSessionId?.(raw.session_id)
    }
    if (raw.type === 'system' && raw.subtype === 'init' && typeof raw.model === 'string') session.options.onModelResolved?.(raw.model)
    let message = normalizeCcbMessage({ ...raw, type: raw.type, _createdAt: event.timestamp, _runtimeGeneration: event.generation,
      _runtimeSequence: event.seq, _runtimeRunId: event.runId, _promaNativeMessage: true } as SDKMessage)
    if (raw.type === 'stream_event') {
      const update = applyCcbPartialAssistantEvent(session.partial, message)
      session.partial = update.state
      if (!update.message) return
      message = update.message
    } else if (raw.type === 'assistant') {
      const update = annotateCcbFinalAssistantMessage(session.partial, message)
      session.partial = update.state
      message = update.message || message
    }
    if (!['user', 'assistant', 'system', 'result', 'tool_progress', 'tool_use_summary'].includes(message.type)) return
    // partial assistant 是 stream_event 派生的可变快照；只将 CLI 确认的原生消息实时落盘。
    if (raw.type !== 'stream_event' && ['user', 'assistant', 'system', 'result'].includes(message.type)) {
      session.options.onNativeMessage?.(message)
    }
    if (event.runId && session.recoveringRunIds.has(event.runId)) return
    const isForegroundRun = Boolean(session.queue && event.runId && event.runId === session.runId)
    if (isForegroundRun && session.queue) {
      session.queue.push(message)
      if (message.type === 'result') {
        session.queue.end()
        session.queue = undefined
      }
    } else {
      this.onBackgroundMessage?.(session.options.sessionId, message)
    }
  }

  private startReplayRecovery(client: LocalServiceClient, session: Session, event: LocalServiceEvent): void {
    if (session.replayRecovery) return
    session.replayRecoveryError = undefined
    const recovery = this.recoverReplayReset(client, session, event)
      .catch((failure: unknown) => {
        session.replayRecoveryError = failure instanceof Error ? failure : new Error(String(failure))
      })
      .finally(() => {
        if (session.replayRecovery === recovery) session.replayRecovery = undefined
      })
    session.replayRecovery = recovery
  }

  private async recoverReplayReset(
    client: LocalServiceClient,
    session: Session,
    event: LocalServiceEvent,
  ): Promise<void> {
    const snapshot = parseReplayResetSnapshot(event.payload)
    const gapError = new Error('执行事件日志存在缺口；当前前台轮次已安全停止，已收到的消息与后台任务仍保留')

    // 后台任务不依赖前台轮次，必须按服务权威快照保留，不能通过关闭进程恢复。
    session.activeTasks = new Set(snapshot.runningTaskIds)

    const authoritativeControlIds = new Set(snapshot.pendingControls.map(control => control.cliRequestId))
    for (const [requestId, signal] of session.controlSignals) {
      if (authoritativeControlIds.has(requestId)) continue
      signal.abort()
      session.controlSignals.delete(requestId)
      session.controls.delete(requestId)
    }
    for (const requestId of session.controls) {
      if (!authoritativeControlIds.has(requestId)) session.controls.delete(requestId)
    }
    for (const pending of snapshot.pendingControls) {
      if (session.controls.has(pending.cliRequestId)) continue
      void this.respond(client, session, {
        ...event,
        kind: 'control_pending',
        requestId: pending.cliRequestId,
        payload: {
          direction: 'cli_to_host',
          cliRequestId: pending.cliRequestId,
          subtype: pending.subtype,
          request: pending.request as Record<string, unknown>,
        },
      }).catch(() => {})
    }

    // 服务快照没有桌面发往 CLI 的控制请求结果，继续等待会造成永久悬挂。
    this.rejectPendingControls(session, gapError)

    const activeRunIds = new Set<string>([
      ...(session.runId ? [session.runId] : []),
      ...(snapshot.activeRunId ? [snapshot.activeRunId] : []),
    ])
    const queuedRunIds = [...session.queuedRuns.keys()].filter(runId => !activeRunIds.has(runId))
    const runIds = new Set<string>([...queuedRunIds, ...activeRunIds])
    session.recoveringRunIds = runIds

    // 先移除队列项，避免活动轮次终止后 dispatchNext 把旧消息真正发送给 CLI。
    const queuedResults = await Promise.allSettled(
      queuedRunIds.map(runId => this.interruptReplayRun(client, session, event.seq, runId)),
    )
    const activeResults = await Promise.allSettled(
      [...activeRunIds].map(runId => this.interruptReplayRun(client, session, event.seq, runId)),
    )
    const results = [...queuedResults, ...activeResults]
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')

    let recoveryFailure: unknown = failed?.reason
    // 原轮次收敛后只读取原生快照，补齐显示投影；不经过实时副作用路径。
    if (!failed && session.options.onNativeHistory) {
      try {
        const history = await readNativeTranscript(payload => this.controlWithoutRecoveryWait(session, 'get_session_transcript', payload))
        await session.options.onNativeHistory(history)
      } catch (error) {
        recoveryFailure = error
      }
    }
    session.partial = createCcbPartialAssistantState()
    session.queue?.end(gapError)
    session.queue = undefined
    session.runId = undefined
    session.recoveringRunIds.clear()
    this.rejectQueuedRuns(session, gapError)
    this.rejectTerminalWaiters(session, gapError)

    if (recoveryFailure) {
      throw new Error(`事件日志恢复失败，已阻止继续发送：${recoveryFailure instanceof Error ? recoveryFailure.message : String(recoveryFailure)}`)
    }
  }

  private async interruptReplayRun(
    client: LocalServiceClient,
    session: Session,
    replayResetSeq: number,
    runId: string,
  ): Promise<void> {
    const terminal = this.waitForRunTerminal(session, runId)
    try {
      await client.request('session.interrupt', {
        sessionId: session.options.sessionId,
        requestId: randomUUID(),
        runId,
      })
      const authoritative = await client.request<{
        activeRunId?: string
        events?: Array<{ kind?: string; runId?: string; payload?: Record<string, unknown> }>
      }>('session.snapshot', {
        sessionId: session.options.sessionId,
        afterSeq: replayResetSeq,
      })
      const terminalEvent = authoritative.events?.find(candidate => candidate.kind === 'run_state'
        && candidate.runId === runId && TERMINAL_RUN_STATES.has(String(candidate.payload?.state || '')))
      if (terminalEvent) {
        this.settleRunTerminal(session, runId, String(terminalEvent.payload?.state || 'interrupted'), true)
      } else if (authoritative.activeRunId !== runId) {
        // interrupt RPC 同步移除队列项；快照确认它也不是活动轮次时即可收敛本地状态。
        this.settleRunTerminal(session, runId, 'interrupted', true)
      }
      await terminal.promise
    } catch (error) {
      terminal.cancel()
      throw error
    }
  }

  private async awaitReplayRecovery(session: Session): Promise<void> {
    if (session.replayRecovery) await session.replayRecovery
    if (session.replayRecoveryError) throw session.replayRecoveryError
  }

  private failSession(session: Session, error: Error): void {
    session.controller.abort()
    for (const signal of session.controlSignals.values()) signal.abort()
    session.controlSignals.clear()
    session.activeTasks.clear()
    session.ready = false
    session.queue?.end(error)
    session.queue = undefined
    session.runId = undefined
    this.rejectPendingControls(session, error)
    this.rejectQueuedRuns(session, error)
    this.rejectTerminalWaiters(session, error)
  }

  private settleRunTerminal(session: Session, runId: string, state: string, preserveForegroundQueue = false): void {
    if (session.runId === runId) {
      if (!preserveForegroundQueue) {
        if (state === 'failed') session.queue?.end(new Error('CLI 轮次执行失败'))
        else session.queue?.end()
        session.queue = undefined
        session.runId = undefined
      }
    }
    const queued = session.queuedRuns.get(runId)
    if (queued) {
      if (!queued.started) {
        queued.reject(new Error(state === 'interrupted' ? '队列消息已取消' : 'CLI 未消费队列消息'))
      }
      session.queuedRuns.delete(runId)
    }
    const waiters = session.terminalWaiters.get(runId)
    if (!waiters) return
    session.terminalWaiters.delete(runId)
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  private async respond(client: LocalServiceClient, session: Session, event: LocalServiceEvent): Promise<void> {
    const pending = record(event.payload.message || event.payload)
    const request = record(pending.request || event.payload.request)
    const requestId = String(pending.request_id || event.payload.cliRequestId || event.requestId || '')
    if (!requestId || session.controls.has(requestId)) return
    session.controls.add(requestId)
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    const sessionSignal = session.controller.signal
    sessionSignal.addEventListener('abort', abort, { once: true })
    if (sessionSignal.aborted) controller.abort()
    session.controlSignals.set(requestId, controller)
    let response: Record<string, unknown>
    try {
      if (request.subtype === 'can_use_tool' && !toolPolicyAllows(session.options.toolPolicy, String(request.tool_name || ''))) {
        response = { behavior: 'deny', message: '此工具不在当前 Agent 的允许范围内' }
      } else if (request.subtype !== 'can_use_tool' || !session.options.canUseTool) {
        response = { behavior: 'deny', message: '桌面未实现此交互请求' }
      } else {
        response = await session.options.canUseTool(String(request.tool_name || ''), record(request.input), {
          signal: controller.signal, toolUseID: String(request.tool_use_id || requestId),
          decisionReason: typeof request.decision_reason === 'string' ? request.decision_reason : undefined,
          blockedPath: typeof request.blocked_path === 'string' ? request.blocked_path : undefined,
        })
      }
      if (!controller.signal.aborted) await client.request('session.respond', { sessionId: session.options.sessionId, requestId: randomUUID(), cliRequestId: requestId, response })
    } catch {
      if (!controller.signal.aborted) await client.request('session.respond', { sessionId: session.options.sessionId, requestId: randomUUID(), cliRequestId: requestId,
        response: { behavior: 'deny', message: '交互已取消' } }).catch(() => {})
    } finally {
      sessionSignal.removeEventListener('abort', abort)
      session.controlSignals.delete(requestId)
    }
  }

  async *query(input: AgentQueryInput): AsyncGenerator<SDKMessage> {
    const options = input as LocalCliAgentQueryOptions
    const session = await this.ensureSession(options)
    await this.awaitReplayRecovery(session)
    if (session.queue) throw new Error('同一会话已有正在执行的轮次')
    session.controller = new AbortController()
    const queue = new MessageQueue()
    session.queue = queue
    session.runId = randomUUID()
    const abort = (): void => { void this.abort(input.sessionId).catch((error: unknown) => queue.end(error instanceof Error ? error : new Error(String(error)))) }
    options.abortSignal?.addEventListener('abort', abort, { once: true })
    try {
      const client = await localServiceSupervisor.getClient()
      await client.request('session.send', { sessionId: input.sessionId, requestId: randomUUID(), runId: session.runId,
        content: input.compactRequest ? '/compact' : options.messageContent ?? input.prompt })
      yield* queue.read()
    } finally {
      options.abortSignal?.removeEventListener('abort', abort)
      if (session.queue === queue) session.queue = undefined
    }
  }

  private rejectPendingControls(session: Session, error: Error): void {
    for (const pending of session.pendingControls.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
      pending.settle()
    }
    session.pendingControls.clear()
  }

  private rejectQueuedRuns(session: Session, error: Error): void {
    for (const queued of session.queuedRuns.values()) {
      queued.reject(error)
    }
    session.queuedRuns.clear()
  }

  private rejectTerminalWaiters(session: Session, error: Error): void {
    for (const waiters of session.terminalWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
    }
    session.terminalWaiters.clear()
  }

  private waitForRunTerminal(session: Session, runId: string): {
    promise: Promise<void>
    cancel: () => void
  } {
    let waiter: RunTerminalWaiter | undefined
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = session.terminalWaiters.get(runId)
        if (waiter) waiters?.delete(waiter)
        if (waiters?.size === 0) session.terminalWaiters.delete(runId)
        reject(new Error('CLI 中断确认超时'))
      }, 120_000)
      waiter = { resolve, reject, timer }
      const waiters = session.terminalWaiters.get(runId) ?? new Set<RunTerminalWaiter>()
      waiters.add(waiter)
      session.terminalWaiters.set(runId, waiters)
    })
    void promise.catch(() => {})
    const cancel = (): void => {
      if (!waiter) return
      clearTimeout(waiter.timer)
      const waiters = session.terminalWaiters.get(runId)
      waiters?.delete(waiter)
      if (waiters?.size === 0) session.terminalWaiters.delete(runId)
    }
    return { promise, cancel }
  }

  async control(sessionId: string, subtype: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Runtime Session 尚未打开。')
    await this.awaitReplayRecovery(session)
    return this.controlWithoutRecoveryWait(session, subtype, payload)
  }

  private async controlWithoutRecoveryWait(session: Session, subtype: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const sessionId = session.options.sessionId
    const client = await localServiceSupervisor.getClient()
    const requestId = randomUUID()
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingControls.delete(requestId)
        reject(new Error(`CLI 控制请求超时：${subtype}`))
        settle()
      }, 120_000)
      session.pendingControls.set(requestId, { subtype, resolve, reject, settled, settle, timer })
    })
    void response.catch(() => {})
    try {
      await client.request('session.control', { sessionId, requestId, subtype, payload })
    } catch (error) {
      const pending = session.pendingControls.get(requestId)
      if (pending) {
        clearTimeout(pending.timer)
        session.pendingControls.delete(requestId)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
        pending.settle()
      }
      return response
    }
    return response
  }
  async abort(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    await this.awaitReplayRecovery(session)
    session.controller.abort()
    const client = await localServiceSupervisor.getClient()
    const runId = session.runId
      ?? [...session.queuedRuns.entries()].find(([, queued]) => queued.started)?.[0]
      ?? [...session.queuedRuns.keys()][0]
    if (!runId) {
      await client.request('session.interrupt', { sessionId, requestId: randomUUID() })
      return
    }
    const terminal = this.waitForRunTerminal(session, runId)
    try {
      await client.request('session.interrupt', { sessionId, requestId: randomUUID(), runId })
      await terminal.promise
    } catch (error) {
      terminal.cancel()
      throw error
    }
  }
  interruptQuery(sessionId: string): Promise<void> { return this.abort(sessionId) }
  async setPermissionMode(sessionId: string, mode: string): Promise<void> { await this.control(sessionId, 'set_permission_mode', { mode }) }
  async updateRuntimeConfig(sessionId: string, updates: {
    model?: string
    thinkingConfig?: ThinkingConfig | null
    effortLevel?: ThinkingEffortLevel | null
  }): Promise<boolean> {
    if (!this.sessions.has(sessionId)) return false
    if (updates.model) await this.control(sessionId, 'set_model', { model: updates.model })
    if (updates.effortLevel !== undefined) {
      await this.control(sessionId, 'set_effort', { effort: updates.effortLevel })
    }
    if (updates.thinkingConfig !== undefined) {
      const thinkingConfig = updates.thinkingConfig
      await this.control(sessionId, 'set_max_thinking_tokens', {
        max_thinking_tokens: thinkingConfig === null
          ? null
          : thinkingConfig.type === 'disabled'
            ? 0
            : 'budgetTokens' in thinkingConfig
              ? thinkingConfig.budgetTokens
              : null,
      })
    }
    return true
  }
  async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput, options?: SendQueuedMessageOptions): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Runtime Session 尚未打开。')
    await this.awaitReplayRecovery(session)
    const client = await localServiceSupervisor.getClient()
    const runId = randomUUID()
    const started = new Promise<void>((resolve, reject) => {
      // 排队可能跨越长工具或审批等待。只能由服务的开始、取消、失败结算，
      // 不能本地超时后遗留仍会执行的队列项，让用户重试产生重复操作。
      session.queuedRuns.set(runId, { started: false, resolve, reject })
    })
    // RPC 成功只表示已入队；run_state=running 才表示 CLI 已实际消费。
    void started.catch(() => {})
    try {
      await client.request('session.send', {
        sessionId,
        requestId: message.uuid || randomUUID(),
        content: message.messageContent ?? message.rawText ?? message.message.content,
        runId,
        priority: message.priority,
        interrupt: options?.interrupt === true,
      })
      options?.onAccepted?.()
    } catch (error) {
      const pending = session.queuedRuns.get(runId)
      if (pending) {
        session.queuedRuns.delete(runId)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
      throw error
    }
    return started
  }
  canStopTask(sessionId: string, taskId: string): boolean {
    const session = this.sessions.get(sessionId)
    return session?.ready === true && session.activeTasks.has(taskId)
  }
  async stopTask(sessionId: string, taskId: string): Promise<void> {
    // 等待 CLI 的真实停止结果，不能将 HTTP 入队回执当成任务已停止。
    await this.control(sessionId, 'stop_task', { task_id: taskId })
  }
  async readTaskOutput(sessionId: string, taskId: string): Promise<string | null> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话尚未打开，后台任务日志不可用')
    return session.outputReader.read(taskId, (cursor, byteLimit) => this.control(sessionId, 'get_task_output', {
      task_id: taskId, cursor, byte_limit: byteLimit,
    }))
  }
  async getCommandCatalog(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话尚未打开，原生命令目录不可用')
    // 打开目录时读取 CLI 的最新 Skills，安装或编辑 Skill 不必重启会话。
    await this.refreshSkillCatalog(session, session.options.additionalSkillDirectories ?? [])
    return session.configuration
  }
  private async refreshSkillCatalog(session: Session, directories: string[]): Promise<void> {
    const catalog = await this.control(session.options.sessionId, 'set_skill_directories', { directories })
    if (!Array.isArray(catalog.commands)) throw new Error('CLI 返回了无效的命令目录')
    session.configuration = { ...session.configuration, commands: catalog.commands }
  }
  async getExecutionGraph(sessionId: string): Promise<import('@proma/shared').AgentRuntimeExecutionGraph> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话尚未打开，执行任务快照不可用')
    const snapshot = await this.control(sessionId, 'get_tasks')
    if (Array.isArray(snapshot.todos)) session.todos = projectLocalCliTodos(snapshot.todos)
    const graph = projectLocalCliTasks(snapshot, session.nativeSessionId, session.todos)
    session.activeTasks = new Set(graph.nodes.filter(node => node.status === 'running').map(node => node.id))
    return graph
  }
  async getSubagentTranscript(sessionId: string, taskId: string): Promise<import('@proma/shared').AgentRuntimeSubagentTranscript> {
    return projectLocalCliTaskTranscript(taskId, await this.control(sessionId, 'get_subagent_transcript', { task_id: taskId }))
  }
  async setAutoCompact(sessionId: string, enabled: boolean): Promise<Record<string, unknown>> {
    const result = await this.control(sessionId, 'set_auto_compact', { enabled })
    const session = this.sessions.get(sessionId)
    if (session) session.options = { ...session.options, autoCompactEnabled: enabled }
    return result
  }
  async getContextUsage(sessionId: string): Promise<Record<string, unknown>> { return this.control(sessionId, 'get_context_usage') }
  async forkSession(
    input: AgentRuntimeSessionOperationInput,
    upToMessageUuid?: string,
  ): Promise<AgentRuntimeForkResult> {
    const targetSessionId = input.targetSessionId
    if (!targetSessionId) throw new Error('分叉前必须预留目标会话 ID')
    if (this.sessions.has(targetSessionId)) throw new Error('目标分叉会话已打开')
    await this.ensureSession({
      sessionId: targetSessionId,
      prompt: '',
      cwd: input.cwd,
      model: input.model,
      fallbackModel: input.fallbackModel,
      env: input.env,
      providerConfiguration: input.providerConfiguration,
      sdkPermissionMode: input.permissionMode,
      thinkingConfig: input.thinkingConfig,
      effortLevel: input.effortLevel,
      mcpServers: input.mcpServers,
      systemPrompt: input.systemPrompt,
      additionalSkillDirectories: input.additionalSkillDirectories,
      additionalDirectories: input.additionalDirectories,
      autoCompactEnabled: input.autoCompactEnabled,
      resumeSessionId: input.runtimeSessionId,
      resumeSessionAt: upToMessageUuid,
      forkSession: true,
    })
    return { runtimeSessionId: targetSessionId }
  }

  async rewindSession(
    input: AgentRuntimeSessionOperationInput,
    messageUuid: string,
  ): Promise<AgentRuntimeRewindResult> {
    let fileRewind: AgentRuntimeRewindResult['fileRewind']
    if (input.rewindFiles) {
      if (!input.rewindUserMessageId) throw new Error('文件回退缺少用户消息检查点')
      const response = await this.control(input.sessionId, 'rewind_files', {
        user_message_id: input.rewindUserMessageId,
      })
      if (typeof response.canRewind !== 'boolean') {
        throw new Error('CLI 返回了无效的文件回退结果')
      }
      fileRewind = {
        canRewind: response.canRewind,
        ...(typeof response.error === 'string' ? { error: response.error } : {}),
        ...(Array.isArray(response.filesChanged)
          && response.filesChanged.every((path) => typeof path === 'string')
          ? { filesChanged: response.filesChanged as string[] }
          : {}),
        ...(typeof response.insertions === 'number' ? { insertions: response.insertions } : {}),
        ...(typeof response.deletions === 'number' ? { deletions: response.deletions } : {}),
      }
    }
    await this.closeSession(input.sessionId)
    await this.ensureSession({
      sessionId: input.sessionId,
      prompt: '',
      cwd: input.cwd,
      model: input.model,
      fallbackModel: input.fallbackModel,
      env: input.env,
      providerConfiguration: input.providerConfiguration,
      sdkPermissionMode: input.permissionMode,
      thinkingConfig: input.thinkingConfig,
      effortLevel: input.effortLevel,
      mcpServers: input.mcpServers,
      systemPrompt: input.systemPrompt,
      additionalSkillDirectories: input.additionalSkillDirectories,
      additionalDirectories: input.additionalDirectories,
      autoCompactEnabled: input.autoCompactEnabled,
      resumeSessionId: input.runtimeSessionId,
      resumeSessionAt: messageUuid,
    })
    return {
      runtimeSessionId: input.runtimeSessionId,
      resumeAtMessageUuid: messageUuid,
      ...(fileRewind ? { fileRewind } : {}),
    }
  }
  async compactSession(input: AgentRuntimeSessionOperationInput, instructions?: string): Promise<void> {
    const previous = this.sessions.get(input.sessionId)?.options
    const options: LocalCliAgentQueryOptions = {
      ...previous, ...input, sdkPermissionMode: input.permissionMode,
      prompt: `/compact${instructions ? ` ${instructions}` : ''}`,
      resumeSessionId: input.runtimeSessionId,
    }
    // 非发送入口的压缩也必须经过同一持久化和事件发布路径。
    for await (const message of this.query(options)) {
      this.onBackgroundMessage?.(input.sessionId, message)
    }
  }
  async clearSession(input: AgentRuntimeSessionOperationInput): Promise<AgentRuntimeClearResult> {
    return this.preparation.run(input.sessionId, async () => {
      const session = this.sessions.get(input.sessionId)
      if (session && (session.queue || session.queuedRuns.size || session.pendingControls.size
        || session.controlSignals.size || session.activeTasks.size)) {
        throw new Error('会话仍有执行、后台任务或待处理请求，请先处理完成再清空')
      }
      const nativeSessionId = input.nativeSessionId ?? randomUUID()
      const previous = session?.options
      try {
      await this.closeSession(input.sessionId)
      await this.prepareSessionUnlocked({
        ...previous, ...input, prompt: '', nativeSessionId,
        sdkPermissionMode: input.permissionMode,
        resumeSessionId: undefined, resumeSessionAt: undefined, forkSession: undefined,
        historyMessages: undefined, messageContent: undefined,
      })
      } catch (cause) {
        throw Object.assign(new Error('清空后的 CLI 重建未完成，下次执行将使用已预留的新会话', { cause }), { code: 'RUNTIME_CLEAR_RESTART_REQUIRED' })
      }
      return { runtimeSessionId: nativeSessionId }
    })
  }
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const error = new Error('Runtime Session 已关闭。')
    try {
      const client = await localServiceSupervisor.getClient()
      if (session.ready) await client.request('session.close', { sessionId })
      else await client.request('session.close', { sessionId }).catch(() => {})
    } finally {
      session.controller.abort()
      for (const signal of session.controlSignals.values()) signal.abort()
      session.controlSignals.clear()
      session.queue?.end()
      this.rejectPendingControls(session, error)
      this.rejectQueuedRuns(session, error)
      this.rejectTerminalWaiters(session, error)
      session.unsubscribe()
      this.sessions.delete(sessionId)
      await releaseLocalCliMcpServers(sessionId)
    }
  }
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId)))
    await localServiceSupervisor.dispose()
  }
}

import { randomUUID, type UUID } from 'node:crypto'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { fileHistoryRewind } from '../utils/fileHistory.js'
import {
  createHeadlessRuntimeSession,
  type HeadlessRuntimeSession,
} from './bootstrap/createHeadlessRuntimeSession.js'
import {
  forkRuntimeTranscript,
  resolveRewindUserMessageUuid,
} from './bootstrap/session-transcript.js'
import { resolveDesktopModelCatalog } from './models/modelCatalog.js'
import {
  deleteDesktopSession,
  resolveDesktopSessionCatalog,
  resolveDesktopSessionTranscript,
} from './sessions/sessionCatalog.js'
import { resolveDesktopSkillCatalog } from './skills/skillCatalog.js'
import type { ClaudeCodeDesktopHostBridge } from './bridge/DesktopHostBridge.js'
import {
  DESKTOP_PROTOCOL_VERSION,
  type RuntimeCommand,
  type RuntimeEnvelope,
  type RuntimeEvent,
  type RuntimeInteractionResponse,
  type RuntimeSessionOptions,
  type WorkerCommandMessage,
  type WorkerEventMessage,
} from './protocol/types.js'
import {
  assertCommandEnvelope,
  assertEventEnvelope,
} from './protocol/validation.js'
import {
  isTerminalTurnMessage,
  nextTurnMessageOrAbort,
  TurnIdleBarrier,
} from './turnLifecycle.js'
import {
  buildBackgroundContinuationPrompt,
  hasActiveBackgroundExecutionNodes,
  isMainThreadTaskNotification,
} from './backgroundTurnContinuation.js'
import {
  dequeueAllMatching,
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from '../utils/messageQueueManager.js'

interface PendingInteraction {
  resolve: (response: RuntimeInteractionResponse) => void
  reject: (error: Error) => void
}

let session: HeadlessRuntimeSession | undefined
let sessionOptions: RuntimeSessionOptions | undefined
let sessionId: string | undefined
let sequence = 0
let running = false
let stopRequested = false
let softInterruptRequested = false
let executionGraphTimer: ReturnType<typeof setTimeout> | undefined
let lastExecutionGraphFingerprint = ''
const turnQueue: Array<{ prompt: string; uuid?: string }> = []
const pendingInteractions = new Map<string, PendingInteraction>()
const turnIdleBarrier = new TurnIdleBarrier()
let wakeBackgroundNotificationWait: (() => void) | undefined

async function publishExecutionGraph(
  force: boolean = false,
): Promise<Awaited<ReturnType<HeadlessRuntimeSession['getExecutionGraph']>> | undefined> {
  if (!session) return undefined
  const graph = await session.getExecutionGraph()
  const fingerprint = JSON.stringify({
    nodes: graph.nodes,
    todos: graph.todos,
  })
  if (!force && fingerprint === lastExecutionGraphFingerprint) return graph
  lastExecutionGraphFingerprint = fingerprint
  send({ type: 'runtime.executionGraphChanged', graph })
  return graph
}

function scheduleExecutionGraphPublish(): void {
  if (executionGraphTimer) return
  executionGraphTimer = setTimeout(() => {
    executionGraphTimer = undefined
    void publishExecutionGraph().catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      send({
        type: 'runtime.log',
        level: 'warn',
        message: `执行图同步失败: ${message}`,
      })
    })
  }, 80)
  executionGraphTimer.unref?.()
}

function cancelPendingInteractions(message: string): void {
  const error = new Error(message)
  for (const pending of pendingInteractions.values()) pending.reject(error)
  pendingInteractions.clear()
}

function send(payload: RuntimeEvent, requestId: string = randomUUID()): void {
  const message: WorkerEventMessage = {
    kind: 'event',
    envelope: {
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      requestId,
      sessionId,
      sequence: ++sequence,
      timestamp: Date.now(),
      payload,
    },
  }
  assertEventEnvelope(message.envelope)
  process.send?.(message)
}

function waitForInteraction(
  request: { interactionId: string },
  event: RuntimeEvent,
): Promise<RuntimeInteractionResponse> {
  send(event)
  return new Promise((resolve, reject) => {
    pendingInteractions.set(request.interactionId, { resolve, reject })
  })
}

const bridge: ClaudeCodeDesktopHostBridge = {
  emitMessage: message => {
    send({ type: 'runtime.message', message })
  },
  emitProgress: (phase, detail, data) => {
    send({
      type: 'runtime.progress',
      phase,
      ...(detail ? { detail } : {}),
      ...(data ? { data } : {}),
    })
  },
  requestPermission: request =>
    waitForInteraction(request, {
      type: 'interaction.permissionRequested',
      request,
    }),
  askUser: request =>
    waitForInteraction(request, {
      type: 'interaction.askUserRequested',
      request,
    }),
  approvePlan: request =>
    waitForInteraction(request, {
      type: 'interaction.planApprovalRequested',
      request,
    }),
  emitCredentialsUpdated: credentials => {
    send({
      type: 'runtime.credentialsUpdated',
      provider: 'openai-codex',
      credentials: {
        access: credentials.accessToken,
        refresh: credentials.refreshToken,
        expires: credentials.expiresAt,
        ...(credentials.accountId ? { accountId: credentials.accountId } : {}),
      },
    })
  },
}

function hasPendingMainThreadTaskNotification(): boolean {
  return getCommandQueueSnapshot().some(isMainThreadTaskNotification)
}

function takeBackgroundContinuationPrompt(): string | undefined {
  return buildBackgroundContinuationPrompt(
    dequeueAllMatching(isMainThreadTaskNotification),
  )
}

/** 后台 Agent 等待不设超时；Stop、新消息或完成通知都会立即唤醒。 */
function waitForBackgroundNotification(): Promise<void> {
  if (
    stopRequested
    || softInterruptRequested
    || turnQueue.length > 0
    || hasPendingMainThreadTaskNotification()
  ) {
    return Promise.resolve()
  }

  return new Promise(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      unsubscribe()
      if (wakeBackgroundNotificationWait === finish) {
        wakeBackgroundNotificationWait = undefined
      }
      resolve()
    }
    const unsubscribe = subscribeToCommandQueue(() => {
      if (hasPendingMainThreadTaskNotification()) finish()
    })
    wakeBackgroundNotificationWait = finish
    if (
      stopRequested
      || softInterruptRequested
      || turnQueue.length > 0
      || hasPendingMainThreadTaskNotification()
    ) {
      finish()
    }
  })
}

async function executeSessionPrompt(
  prompt: string,
  uuid?: string,
  isMeta: boolean = false,
): Promise<SDKMessage | undefined> {
  if (!session) return undefined
  let last: SDKMessage | undefined
  const messages = session
    .submit(prompt, uuid, isMeta)
    [Symbol.asyncIterator]()
  const abortSignal = session.getAbortSignal()
  try {
    while (!abortSignal.aborted) {
      const result = await nextTurnMessageOrAbort(messages, abortSignal)
      if (result.done || abortSignal.aborted) break
      const message = result.value
      last = message
      send({ type: 'runtime.message', message })
      scheduleExecutionGraphPublish()
      if (
        isTerminalTurnMessage(message)
        || stopRequested
        || softInterruptRequested
      ) {
        break
      }
    }
    return last
  } finally {
    session.resetAfterInterrupt()
  }
}

async function runTurnQueue(): Promise<void> {
  if (!session || running || turnQueue.length === 0) return
  running = true
  stopRequested = false
  send({
    type: 'session.stateChanged',
    state: 'busy',
    runtimeSessionId: session.runtimeSessionId,
  })
  let last: SDKMessage | undefined
  try {
    while (!stopRequested) {
      const next = turnQueue.shift()
      if (!next) break
      softInterruptRequested = false
      try {
        last = (await executeSessionPrompt(next.prompt, next.uuid)) ?? last

        // 父模型文本结束不等于 CCB 原生后台子智能体结束。只要执行图仍有
        // queued/running 节点，Worker 保持 busy，等待完成通知后通过隐藏
        // meta Turn 让父模型处理结果并继续任务。
        while (
          !stopRequested
          && !softInterruptRequested
          && turnQueue.length === 0
        ) {
          const graph = await publishExecutionGraph(true)
          let continuationPrompt = takeBackgroundContinuationPrompt()
          if (
            !continuationPrompt
            && graph
            && hasActiveBackgroundExecutionNodes(graph)
          ) {
            await waitForBackgroundNotification()
            if (
              stopRequested
              || softInterruptRequested
              || turnQueue.length > 0
            ) {
              break
            }
            continuationPrompt = takeBackgroundContinuationPrompt()
          }
          if (!continuationPrompt) break
          last = (
            await executeSessionPrompt(
              continuationPrompt,
              undefined,
              true,
            )
          ) ?? last
        }
        if (softInterruptRequested) {
          // 若 Interrupt 发生在后台通知等待阶段，此时没有活跃迭代器负责重置
          // AbortController；必须在处理插队的新消息前恢复下一轮可用状态。
          session.resetAfterInterrupt()
        }
      } catch (error) {
        if (!stopRequested && !softInterruptRequested) {
          const err = error instanceof Error ? error : new Error(String(error))
          turnQueue.length = 0
          send({
            type: 'turn.failed',
            error: {
              code: 'TURN_FAILED',
              message: err.message,
              stack: err.stack,
              recoverable: true,
            },
          })
          return
        }
      }
    }
    await publishExecutionGraph(true)
    send({ type: 'turn.completed', result: last })
  } finally {
    session.resetAfterInterrupt()
    running = false
    stopRequested = false
    softInterruptRequested = false
    send({
      type: 'session.stateChanged',
      state: 'ready',
      runtimeSessionId: session.runtimeSessionId,
    })
    turnIdleBarrier.resolve()
    if (turnQueue.length > 0) void runTurnQueue()
  }
}

async function replaceSession(
  options: RuntimeSessionOptions,
  resume: boolean,
): Promise<HeadlessRuntimeSession> {
  cancelPendingInteractions('Runtime Session 已切换')
  await session?.dispose()
  sessionOptions = { ...options, resume }
  session = await createHeadlessRuntimeSession(sessionOptions, bridge)
  return session
}

async function handleCommand(
  envelope: RuntimeEnvelope<RuntimeCommand>,
): Promise<void> {
  const command = envelope.payload
  switch (command.type) {
    case 'session.resolveModelCatalog':
      if (session) {
        throw new Error(
          '已打开的 Session 不能切换 Provider 配置，请先关闭或重新打开 Session',
        )
      }
      sessionId = envelope.sessionId
      send(
        {
          type: 'response.success',
          responseTo: envelope.requestId,
          result: resolveDesktopModelCatalog(
            command.cwd,
            command.environment,
            command.providerConfiguration,
          ),
        },
        envelope.requestId,
      )
      return
    case 'session.list':
      if (session) {
        throw new Error(
          '已打开的 Session 不能读取 Session Catalog，请使用独立请求',
        )
      }
      sessionId = envelope.sessionId
      send(
        {
          type: 'response.success',
          responseTo: envelope.requestId,
          result: await resolveDesktopSessionCatalog(command),
        },
        envelope.requestId,
      )
      return
    case 'session.getTranscript':
      if (session) {
        throw new Error(
          '已打开的 Session 不能读取其他 Transcript，请使用独立请求',
        )
      }
      sessionId = envelope.sessionId
      send(
        {
          type: 'response.success',
          responseTo: envelope.requestId,
          result: await resolveDesktopSessionTranscript(command),
        },
        envelope.requestId,
      )
      return
    case 'session.delete':
      if (session) {
        throw new Error(
          '已打开的 Session 不能删除 Transcript，请先关闭 Session',
        )
      }
      sessionId = envelope.sessionId
      send(
        {
          type: 'response.success',
          responseTo: envelope.requestId,
          result: await deleteDesktopSession(command),
        },
        envelope.requestId,
      )
      return
    case 'session.resolveSkillCatalog':
      if (session) {
        throw new Error(
          '已打开的 Session 不能重新解析 Skill Catalog，请先关闭 Session',
        )
      }
      sessionId = envelope.sessionId
      send(
        {
          type: 'response.success',
          responseTo: envelope.requestId,
          result: await resolveDesktopSkillCatalog(command.options),
        },
        envelope.requestId,
      )
      return
    case 'session.open':
    case 'session.resume': {
      sessionId = envelope.sessionId
      send(
        { type: 'session.stateChanged', state: 'starting' },
        envelope.requestId,
      )
      const opened = await replaceSession(
        {
          ...command.options,
          resume: command.type === 'session.resume' || command.options.resume,
        },
        command.type === 'session.resume' || Boolean(command.options.resume),
      )
      send(
        {
          type: 'response.success',
          responseTo: envelope.requestId,
          result: { runtimeSessionId: opened.runtimeSessionId },
        },
        envelope.requestId,
      )
      send({
        type: 'session.stateChanged',
        state: 'ready',
        runtimeSessionId: opened.runtimeSessionId,
      })
      await publishExecutionGraph(true)
      return
    }
    case 'turn.start':
      if (!session) throw new Error('Session 尚未打开')
      if (running) throw new Error('当前 Session 已有运行中的 Turn')
      turnQueue.push({ prompt: command.prompt, uuid: command.uuid })
      send(
        { type: 'response.success', responseTo: envelope.requestId },
        envelope.requestId,
      )
      void runTurnQueue()
      return
    case 'turn.enqueue':
      turnQueue.push({ prompt: command.prompt, uuid: command.uuid })
      wakeBackgroundNotificationWait?.()
      send(
        { type: 'response.success', responseTo: envelope.requestId },
        envelope.requestId,
      )
      if (!running) void runTurnQueue()
      return
    case 'turn.interrupt':
      softInterruptRequested = true
      session?.interrupt()
      if (command.prompt)
        turnQueue.unshift({ prompt: command.prompt, uuid: command.uuid })
      wakeBackgroundNotificationWait?.()
      send(
        { type: 'response.success', responseTo: envelope.requestId },
        envelope.requestId,
      )
      if (!running && turnQueue.length > 0) void runTurnQueue()
      return
    case 'turn.stop':
      stopRequested = true
      turnQueue.length = 0
      session?.interrupt()
      wakeBackgroundNotificationWait?.()
      // Stop 的成功响应表示 QueryEngine 已真正退出、Worker 已回到 ready，
      // 而不是仅表示“已收到停止命令”。Proma 只有在该 Promise 完成后才能
      // 清除 UI 的运行状态。
      await turnIdleBarrier.wait(running)
      send(
        { type: 'response.success', responseTo: envelope.requestId },
        envelope.requestId,
      )
      return
    case 'session.setPermissionMode':
      session?.setPermissionMode(command.mode)
      send(
        { type: 'response.success', responseTo: envelope.requestId },
        envelope.requestId,
      )
      return
    case 'session.updateConfig':
      if (command.model) session?.setModel(command.model)
      if ('thinkingConfig' in command) {
        session?.setThinkingConfig(command.thinkingConfig)
      }
      if ('effortLevel' in command) {
        session?.setEffortLevel(command.effortLevel)
      }
      if (sessionOptions) {
        sessionOptions = {
          ...sessionOptions,
          model: command.model ?? sessionOptions.model,
          ...('thinkingConfig' in command
            ? { thinkingConfig: command.thinkingConfig }
            : {}),
          ...('effortLevel' in command
            ? { effortLevel: command.effortLevel }
            : {}),
        }
      }
      send(
        { type: 'response.success', responseTo: envelope.requestId },
        envelope.requestId,
      )
      return
    case 'session.setEffortLevel':
      session?.setEffortLevel(command.level)
      if (sessionOptions) {
        sessionOptions = {
          ...sessionOptions,
          effortLevel: command.level,
        }
      }
      send(
        { type: 'response.success', responseTo: envelope.requestId },
        envelope.requestId,
      )
      return
    case 'session.getExecutionGraph':
      if (!session) throw new Error('Session 尚未打开')
      send(
        {
          type: 'response.success',
          responseTo: envelope.requestId,
          result: await session.getExecutionGraph(),
        },
        envelope.requestId,
      )
      return
    case 'session.getSubagentTranscript':
      if (!session) throw new Error('Session 尚未打开')
      send(
        {
          type: 'response.success',
          responseTo: envelope.requestId,
          result: await session.getSubagentTranscript(command.executionNodeId),
        },
        envelope.requestId,
      )
      return
    case 'interaction.resolve': {
      const pending = pendingInteractions.get(command.interactionId)
      if (!pending)
        throw new Error(`Interaction 不存在: ${command.interactionId}`)
      pendingInteractions.delete(command.interactionId)
      pending.resolve(command.response)
      send(
        { type: 'response.success', responseTo: envelope.requestId },
        envelope.requestId,
      )
      return
    }
    case 'session.getState':
      send(
        {
          type: 'response.success',
          responseTo: envelope.requestId,
          result: {
            runtimeSessionId: session?.runtimeSessionId,
            running,
            queuedTurns: turnQueue.length,
          },
        },
        envelope.requestId,
      )
      return
    case 'session.compact':
      if (!session) throw new Error('Session 尚未打开')
      turnQueue.push({
        prompt: command.instructions
          ? `/compact ${command.instructions}`
          : '/compact',
      })
      if (!running) void runTurnQueue()
      send(
        { type: 'response.success', responseTo: envelope.requestId },
        envelope.requestId,
      )
      return
    case 'session.rewind':
      if (!session) throw new Error('Session 尚未打开')
      if (!sessionOptions) throw new Error('Session 启动配置不存在')
      if (running) throw new Error('运行中的 Turn 不能执行 rewind，请先停止')
      {
        const userMessageUuid = await resolveRewindUserMessageUuid(
          command.messageUuid,
        )
        await fileHistoryRewind(updater => {
          updater(session!.getFileHistoryState())
        }, userMessageUuid as UUID)
        const forked = await forkRuntimeTranscript({
          upToMessageUuid: userMessageUuid,
        })
        const resumed = await replaceSession(
          {
            ...sessionOptions,
            runtimeSessionId: forked.runtimeSessionId,
          },
          true,
        )
        turnQueue.length = 0
        send(
          {
            type: 'response.success',
            responseTo: envelope.requestId,
            result: {
              runtimeSessionId: resumed.runtimeSessionId,
              resumeAtMessageUuid: userMessageUuid,
            },
          },
          envelope.requestId,
        )
        send({
          type: 'session.stateChanged',
          state: 'ready',
          runtimeSessionId: resumed.runtimeSessionId,
        })
      }
      return
    case 'session.fork': {
      if (!session) throw new Error('Session 尚未打开')
      if (running) throw new Error('运行中的 Turn 不能执行 fork')
      const forked = await forkRuntimeTranscript({
        upToMessageUuid: command.upToMessageUuid,
      })
      send(
        {
          type: 'response.success',
          responseTo: envelope.requestId,
          result: {
            runtimeSessionId: forked.runtimeSessionId,
            messageCount: forked.messages.length,
          },
        },
        envelope.requestId,
      )
      return
    }
    case 'session.suspend':
      if (running) session?.interrupt()
      stopRequested = true
      wakeBackgroundNotificationWait?.()
      send({
        type: 'session.stateChanged',
        state: 'suspended',
        runtimeSessionId: session?.runtimeSessionId,
      })
      send(
        { type: 'response.success', responseTo: envelope.requestId },
        envelope.requestId,
      )
      return
    case 'session.close':
      cancelPendingInteractions('Runtime Session 已关闭')
      stopRequested = true
      wakeBackgroundNotificationWait?.()
      if (executionGraphTimer) clearTimeout(executionGraphTimer)
      executionGraphTimer = undefined
      lastExecutionGraphFingerprint = ''
      await session?.dispose()
      session = undefined
      sessionOptions = undefined
      turnQueue.length = 0
      send({ type: 'session.stateChanged', state: 'closed' })
      send(
        { type: 'response.success', responseTo: envelope.requestId },
        envelope.requestId,
      )
      return
    default:
      throw new Error(`Worker 不支持命令: ${command.type}`)
  }
}

process.on('message', (value: unknown) => {
  void (async () => {
    try {
      if (
        !value ||
        typeof value !== 'object' ||
        (value as { kind?: string }).kind !== 'command'
      )
        return
      const message = value as WorkerCommandMessage
      assertCommandEnvelope(message.envelope)
      await handleCommand(message.envelope)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      const requestId =
        value && typeof value === 'object'
          ? ((value as { envelope?: { requestId?: string } }).envelope
              ?.requestId ?? randomUUID())
          : randomUUID()
      send(
        {
          type: 'response.failure',
          responseTo: requestId,
          error: {
            code: 'WORKER_COMMAND_FAILED',
            message: err.message,
            stack: err.stack,
          },
        },
        requestId,
      )
    }
  })()
})

async function shutdownWorker(reason: string): Promise<void> {
  cancelPendingInteractions(reason)
  stopRequested = true
  wakeBackgroundNotificationWait?.()
  try {
    await session?.dispose()
  } finally {
    process.exit(0)
  }
}

process.once('disconnect', () => {
  void shutdownWorker('Desktop Host 已断开')
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdownWorker(`Worker 收到 ${signal}`)
  })
}

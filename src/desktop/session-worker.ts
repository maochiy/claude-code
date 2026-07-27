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
const turnQueue: Array<{ prompt: string; uuid?: string }> = []
const pendingInteractions = new Map<string, PendingInteraction>()

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
        for await (const message of session.submit(next.prompt, next.uuid)) {
          last = message
          send({ type: 'runtime.message', message })
          if (stopRequested || softInterruptRequested) break
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
      } finally {
        session.resetAfterInterrupt()
      }
    }
    send({ type: 'turn.completed', result: last })
  } finally {
    running = false
    stopRequested = false
    softInterruptRequested = false
    send({
      type: 'session.stateChanged',
      state: 'ready',
      runtimeSessionId: session.runtimeSessionId,
    })
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
      session?.setThinkingConfig(command.thinkingConfig)
      session?.setEffortLevel(command.effortLevel)
      if (sessionOptions) {
        sessionOptions = {
          ...sessionOptions,
          model: command.model ?? sessionOptions.model,
          thinkingConfig: command.thinkingConfig,
          effortLevel: command.effortLevel,
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

process.once('disconnect', () => {
  cancelPendingInteractions('Desktop Host 已断开')
  void session?.dispose().finally(() => process.exit(0))
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    cancelPendingInteractions(`Worker 收到 ${signal}`)
    void session?.dispose().finally(() => process.exit(0))
  })
}

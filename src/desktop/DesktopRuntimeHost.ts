import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { MessagePort } from 'node:worker_threads'
import { SessionWorkerSupervisor } from './SessionWorkerSupervisor.js'
import { redactRuntimeSecrets } from './bootstrap/environment.js'
import { loadDesktopRuntimeCapabilities } from './capabilities/manifest.js'
import {
  DESKTOP_PROTOCOL_VERSION,
  type RuntimeCapabilities,
  type RuntimeCommand,
  type RuntimeEnvelope,
  type RuntimeEvent,
} from './protocol/types.js'
import {
  assertCommandEnvelope,
  assertEventEnvelope,
} from './protocol/validation.js'

interface ElectronParentPort {
  on(
    event: 'message',
    listener: (event: { data: unknown; ports: MessagePort[] }) => void,
  ): void
  postMessage(message: unknown): void
}

const parentPort = (
  process as typeof process & { parentPort?: ElectronParentPort }
).parentPort

export class DesktopRuntimeHost {
  private controlPort?: MessagePort
  private streamPort?: MessagePort
  private readonly supervisor: SessionWorkerSupervisor
  private readonly capabilities = loadDesktopRuntimeCapabilities()
  private shuttingDown = false

  constructor() {
    const workerEntrypoint = fileURLToPath(
      new URL('./session-worker.js', import.meta.url),
    )
    this.supervisor = new SessionWorkerSupervisor(workerEntrypoint, envelope =>
      this.emit(envelope),
    )
  }

  start(): void {
    if (!parentPort)
      throw new Error('Desktop Host 必须由 Electron utilityProcess 启动')
    process.stderr.write('[CCB Desktop Host] 已启动，等待 Proma 连接\n')
    parentPort.on('message', event => {
      process.stderr.write(
        `[CCB Desktop Host] 收到父进程消息，ports=${event.ports?.length ?? 0}\n`,
      )
      if (!event.data || typeof event.data !== 'object') return
      const data = event.data as { type?: string }
      if (data.type !== 'desktop.attachPorts' || event.ports.length < 2) return
      this.controlPort = event.ports[0]
      this.streamPort = event.ports[1]
      this.controlPort.on('message', event => void this.handle(event.data))
      this.controlPort.start()
      this.streamPort.start()
      process.stderr.write('[CCB Desktop Host] 双 MessagePort 已连接\n')
      this.emit({
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        requestId: randomUUID(),
        timestamp: Date.now(),
        payload: {
          type: 'host.ready',
          runtimeVersion: MACRO.VERSION,
          capabilities: this.getCapabilities(),
        },
      })
    })
    process.once('disconnect', () => void this.shutdown())
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => void this.shutdown())
    }
  }

  private async handle(value: unknown): Promise<void> {
    try {
      assertCommandEnvelope(value)
      const envelope = value
      switch (envelope.payload.type) {
        case 'host.initialize':
          if (
            envelope.payload.expectedRuntimeVersion &&
            envelope.payload.expectedRuntimeVersion !== MACRO.VERSION
          ) {
            throw new Error(
              `Runtime 版本不兼容: expected=${envelope.payload.expectedRuntimeVersion}, actual=${MACRO.VERSION}`,
            )
          }
          this.emit({
            protocolVersion: DESKTOP_PROTOCOL_VERSION,
            requestId: envelope.requestId,
            timestamp: Date.now(),
            payload: {
              type: 'response.success',
              responseTo: envelope.requestId,
              result: {
                runtimeVersion: MACRO.VERSION,
                capabilities: this.getCapabilities(),
              },
            },
          })
          return
        case 'host.getCapabilities':
          this.emit({
            protocolVersion: DESKTOP_PROTOCOL_VERSION,
            requestId: envelope.requestId,
            timestamp: Date.now(),
            payload: {
              type: 'response.success',
              responseTo: envelope.requestId,
              result: {
                runtimeVersion: MACRO.VERSION,
                capabilities: this.getCapabilities(),
              },
            },
          })
          return
        case 'host.shutdown':
          await this.supervisor.shutdown()
          this.emit({
            protocolVersion: DESKTOP_PROTOCOL_VERSION,
            requestId: envelope.requestId,
            timestamp: Date.now(),
            payload: {
              type: 'response.success',
              responseTo: envelope.requestId,
            },
          })
          this.shuttingDown = true
          setImmediate(() => process.exit(0))
          return
        default:
          await this.supervisor.dispatch(envelope)
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      const requestId =
        value && typeof value === 'object'
          ? ((value as { requestId?: string }).requestId ?? randomUUID())
          : randomUUID()
      this.emit({
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        requestId,
        timestamp: Date.now(),
        payload: {
          type: 'response.failure',
          responseTo: requestId,
          error: {
            code: 'HOST_COMMAND_FAILED',
            message: err.message,
            stack: err.stack,
          },
        },
      })
    }
  }

  private emit(envelope: RuntimeEnvelope<RuntimeEvent>): void {
    assertEventEnvelope(envelope)
    const streamTypes = new Set([
      'runtime.message',
      'runtime.progress',
      'runtime.log',
    ])
    const port = streamTypes.has(envelope.payload.type)
      ? this.streamPort
      : this.controlPort
    try {
      port?.postMessage(envelope)
    } catch (error) {
      process.stderr.write(
        `[CCB Desktop Host] 发送事件失败: ${redactRuntimeSecrets(error instanceof Error ? error.message : String(error))}\n`,
      )
    }
  }

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    await this.supervisor.shutdown().catch(() => undefined)
    process.exit(0)
  }

  private getCapabilities(): RuntimeCapabilities {
    return this.capabilities
  }
}

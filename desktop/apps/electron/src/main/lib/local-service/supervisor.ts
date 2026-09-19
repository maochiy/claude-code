import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import { getBundledBunPath, getSystemBunPath, getVendorBunPath } from '../bun-finder'
import { getConfigDir } from '../config-paths'
import { LocalServiceClient } from './client'
import { resolveLocalRuntimePaths, type LocalRuntimePaths } from './paths'
import { validateLocalServiceHealth } from './handshake'

const STARTUP_HEALTH_TIMEOUT_MS = 10_000
const SHUTDOWN_RPC_TIMEOUT_MS = 750
const CHILD_TERM_TIMEOUT_MS = 1_500
const CHILD_KILL_TIMEOUT_MS = 1_500

export interface LocalServiceSupervisorOptions {
  startService?: () => Promise<LocalServiceClient>
}

/** 在固定期限内等待 Promise，超时后由调用方继续执行兜底清理。 */
export async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

/** 只终止 Supervisor 自己保存的子进程，并确认 TERM/KILL 后的退出事件。 */
export async function terminateManagedChild(
  child: ChildProcess,
  termTimeoutMs = CHILD_TERM_TIMEOUT_MS,
  killTimeoutMs = CHILD_KILL_TIMEOUT_MS,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  child.kill('SIGTERM')
  if (await waitForChildExit(child, termTimeoutMs)) return true
  child.kill('SIGKILL')
  return waitForChildExit(child, killTimeoutMs)
}

export class LocalServiceSupervisor {
  private child?: ChildProcess
  private client?: LocalServiceClient
  private starting?: Promise<LocalServiceClient>
  private disposePromise?: Promise<void>
  private disposing = false
  private disposed = false
  private paths?: LocalRuntimePaths
  private runtime?: string

  constructor(private readonly options: LocalServiceSupervisorOptions = {}) {}

  async getClient(): Promise<LocalServiceClient> {
    if (this.disposing || this.disposed) throw new Error('本地执行服务正在退出')
    if (this.client) return this.client
    if (!this.starting) {
      const starting = (this.options.startService?.() ?? this.start()).then((client) => {
        if (this.disposing || this.disposed) {
          client.dispose()
          throw new Error('本地执行服务正在退出')
        }
        this.client = client
        return client
      })
      this.starting = starting
      void starting.then(
        () => { if (this.starting === starting) this.starting = undefined },
        () => { if (this.starting === starting) this.starting = undefined },
      )
    }
    return this.starting
  }

  getCliCommand(): { command: string; argv: string[] } {
    if (this.disposing || this.disposed) throw new Error('本地执行服务正在退出')
    if (!this.paths || !this.runtime) throw new Error('本地服务尚未启动')
    return { command: this.runtime, argv: [this.paths.cliEntry] }
  }

  private async start(): Promise<LocalServiceClient> {
    this.paths = resolveLocalRuntimePaths({ appPath: app.getAppPath(), packaged: app.isPackaged,
      resourcesPath: process.resourcesPath, sourceRoot: process.env.XCODES_CLI_SOURCE_ROOT })
    this.runtime = getBundledBunPath() || (app.isPackaged ? null : getVendorBunPath() || getSystemBunPath()) || undefined
    if (!this.runtime) throw new Error('缺少随应用提供的 Bun 运行时')
    if (!existsSync(this.paths.cliEntry) || !existsSync(this.paths.serviceEntry)) throw new Error('CLI 或本地服务产物缺失，请先构建执行内核')
    const token = randomBytes(32).toString('hex')
    const child = spawn(this.runtime, [this.paths.serviceEntry], {
      cwd: this.paths.root,
      env: { ...process.env, XCODES_LOCAL_SERVICE_TOKEN: token, XCODES_DATA_ROOT: getConfigDir() },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    this.child = child
    if (this.disposing || this.disposed) {
      await terminateManagedChild(child)
      throw new Error('本地执行服务正在退出')
    }
    const client = await new Promise<LocalServiceClient>((resolve, reject) => {
      let settled = false
      const lines = createInterface({ input: child.stdout! })
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        lines.close()
        callback()
      }
      const fail = (error: Error): void => finish(() => reject(error))
      const timer = setTimeout(() => {
        fail(new Error('本地服务启动超时'))
        void terminateManagedChild(child)
      }, 20_000)
      child.once('error', fail)
      child.once('exit', () => {
        if (this.child === child) {
          this.child = undefined
          const activeClient = this.client
          this.client = undefined
          activeClient?.dispose(this.disposing ? undefined : new Error('本地执行服务已退出'))
        }
        fail(new Error('本地执行服务已退出'))
      })
      // stderr 不原样记录，避免把子进程内容写入应用诊断日志。
      child.stderr?.resume()
      lines.on('line', (line) => {
        try {
          const ready = JSON.parse(line) as { type?: string; protocolVersion?: number; port?: number }
          if (ready.type !== 'local_service_ready') return
          if (ready.protocolVersion !== 1 || !ready.port) {
            fail(new Error('本地服务协议不兼容'))
            void terminateManagedChild(child)
            return
          }
          finish(() => resolve(new LocalServiceClient(`http://127.0.0.1:${ready.port}`, token)))
        } catch { /* 启动前诊断不是协议消息。 */ }
      })
    })
    try {
      const healthPromise = client.request('service.health')
      const healthSettled = await settleWithin(healthPromise, STARTUP_HEALTH_TIMEOUT_MS)
      if (!healthSettled) throw new Error('本地服务健康检查超时')
      validateLocalServiceHealth(await healthPromise)
      await client.connect()
      if (this.disposing || this.disposed) throw new Error('本地执行服务正在退出')
      if (this.child !== child || child.exitCode !== null || child.signalCode !== null) {
        throw new Error('本地执行服务在启动完成前退出')
      }
      return client
    } catch (error) {
      client.dispose()
      await terminateManagedChild(child)
      if (this.child === child) this.child = undefined
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposing = true
    const client = this.client
    const child = this.child
    this.client = undefined

    this.disposePromise = (async () => {
      if (client) {
        await settleWithin(client.request('service.shutdown'), SHUTDOWN_RPC_TIMEOUT_MS)
        client.dispose()
      }
      if (child) {
        const exited = await terminateManagedChild(child)
        if (!exited) console.warn('[本地服务] 受管子进程未在退出期限内确认结束')
        if (this.child === child) this.child = undefined
      }
      const starting = this.starting
      if (starting) await settleWithin(starting, CHILD_TERM_TIMEOUT_MS + CHILD_KILL_TIMEOUT_MS)
      this.disposed = true
      this.disposing = false
    })()
    return this.disposePromise
  }
}

export const localServiceSupervisor = new LocalServiceSupervisor()

import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: (): string => process.cwd(),
  },
}))

let LocalServiceClient: typeof import('./client').LocalServiceClient
let LocalServiceSupervisor: typeof import('./supervisor').LocalServiceSupervisor
let settleWithin: typeof import('./supervisor').settleWithin
let terminateManagedChild: typeof import('./supervisor').terminateManagedChild

beforeAll(async () => {
  ;({ LocalServiceClient } = await import('./client'))
  ;({ LocalServiceSupervisor, settleWithin, terminateManagedChild } = await import('./supervisor'))
})

class ManagedChildFixture extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: NodeJS.Signals[] = []

  constructor(private readonly exitOnSignal?: NodeJS.Signals) {
    super()
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (signal === this.exitOnSignal) {
      queueMicrotask(() => {
        this.signalCode = signal
        this.emit('exit', null, signal)
      })
    }
    return true
  }
}

function child(fixture: ManagedChildFixture): ChildProcess {
  return fixture as unknown as ChildProcess
}

describe('Local Service 有序退出', () => {
  test('Given 受管子进程响应 TERM When dispose Then 确认退出且不发送 KILL', async () => {
    const fixture = new ManagedChildFixture('SIGTERM')

    expect(await terminateManagedChild(child(fixture), 20, 20)).toBe(true)
    expect(fixture.signals).toEqual(['SIGTERM'])
  })

  test('Given 受管子进程忽略 TERM When 到达期限 Then 升级 KILL 并等待退出', async () => {
    const fixture = new ManagedChildFixture('SIGKILL')

    expect(await terminateManagedChild(child(fixture), 5, 20)).toBe(true)
    expect(fixture.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  test('Given 子进程不响应信号 When 两段期限耗尽 Then 返回失败而不无限等待', async () => {
    const fixture = new ManagedChildFixture()

    expect(await terminateManagedChild(child(fixture), 5, 5)).toBe(false)
    expect(fixture.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  test('Given 任意异步清理不结束 When 超过期限 Then bounded wait 返回 false', async () => {
    expect(await settleWithin(new Promise(() => {}), 5)).toBe(false)
  })

  test('Given 服务仍在启动 When 开始退出 Then 晚到 client 被关闭且不能重新启动', async () => {
    let resolveStart: ((client: InstanceType<typeof LocalServiceClient>) => void) | undefined
    const client = new LocalServiceClient('http://127.0.0.1:1', 'fixture')
    const supervisor = new LocalServiceSupervisor({
      startService: () => new Promise((resolve) => { resolveStart = resolve }),
    })
    const starting = supervisor.getClient()
    const disposing = supervisor.dispose()
    resolveStart?.(client)

    await expect(starting).rejects.toThrow('正在退出')
    await disposing
    await expect(supervisor.getClient()).rejects.toThrow('正在退出')
    await expect(client.request('service.health')).rejects.toThrow('已关闭')
  })
})

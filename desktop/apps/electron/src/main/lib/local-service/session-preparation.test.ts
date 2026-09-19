import { describe, expect, test } from 'bun:test'
import { SessionPreparationGate } from './session-preparation'

describe('会话准备并发', () => {
  test('命令目录与发送同时打开同一会话时，配置等待初始化完成，其他会话仍可启动', async () => {
    const gate = new SessionPreparationGate()
    const events: string[] = []
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    const first = gate.run('a', async () => { events.push('open'); await ready; events.push('initialized') })
    const second = gate.run('a', async () => { events.push('configure') })
    await gate.run('b', async () => { events.push('other') })
    expect(events).toEqual(['open', 'other'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['open', 'other', 'initialized', 'configure'])
  })

  test('初始化失败后，后续恢复可继续且原调用仍收到失败', async () => {
    const gate = new SessionPreparationGate()
    const failed = gate.run('a', async () => { throw new Error('spawn failed') })
    const recovered = gate.run('a', async () => 'recovered')
    await expect(failed).rejects.toThrow('spawn failed')
    expect(await recovered).toBe('recovered')
  })
})

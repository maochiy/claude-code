import { describe, expect, test } from 'bun:test'
import { applyAndPersistSessionAutoCompact } from './agent-session-auto-compact'

describe('会话级自动压缩持久化', () => {
  test('Given Runtime 接受设置 When 切换自动压缩 Then 成功后才持久化偏好', async () => {
    const calls: string[] = []

    const result = await applyAndPersistSessionAutoCompact(
      async () => {
        calls.push('runtime')
        return { enabled: true }
      },
      () => calls.push('persist'),
    )

    expect(result).toEqual({ enabled: true })
    expect(calls).toEqual(['runtime', 'persist'])
  })

  test('Given Runtime 拒绝设置 When 切换自动压缩 Then 不持久化未生效的偏好', async () => {
    let persisted = false

    await expect(applyAndPersistSessionAutoCompact(
      async () => {
        throw new Error('Runtime 拒绝设置')
      },
      () => { persisted = true },
    )).rejects.toThrow('Runtime 拒绝设置')

    expect(persisted).toBe(false)
  })
})

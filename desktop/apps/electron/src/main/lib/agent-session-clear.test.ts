import { describe, expect, test } from 'bun:test'
import { getAgentSessionClearBlocker, resolveAgentSessionRuntimeStart } from './agent-session-clear'

describe('Agent 会话清空守卫', () => {
  test.each([
    [{ active: true, runningBackgroundTasks: 0, pendingInteractions: 0, queuedMessages: 0 }, '执行中'],
    [{ active: false, runningBackgroundTasks: 2, pendingInteractions: 0, queuedMessages: 0 }, '2 个后台任务'],
    [{ active: false, runningBackgroundTasks: 0, pendingInteractions: 3, queuedMessages: 0 }, '3 个待处理请求'],
    [{ active: false, runningBackgroundTasks: 0, pendingInteractions: 0, queuedMessages: 4 }, '4 条待发送消息'],
  ] as const)('Given 会话存在未结工作 When 请求清空 Then 返回明确阻塞原因', (state, expected) => {
    expect(getAgentSessionClearBlocker(state)).toContain(expected)
  })

  test('Given 会话完全空闲 When 请求清空 Then 允许切换新原生会话', () => {
    expect(getAgentSessionClearBlocker({
      active: false,
      runningBackgroundTasks: 0,
      pendingInteractions: 0,
      queuedMessages: 0,
    })).toBeNull()
  })

  test('Given 清空后新原生会话尚未物化 When 应用重启后首次发送 Then 使用预留 ID 且不 resume', () => {
    expect(resolveAgentSessionRuntimeStart({
      runtimeId: 'local-cli',
      runtimeSessionId: 'fresh-native-id',
      pendingFreshNativeSessionId: 'fresh-native-id',
    }, 'local-cli')).toEqual({
      nativeSessionId: 'fresh-native-id',
    })
  })

  test('Given 新原生会话已物化 When 后续发送 Then 使用已保存 ID resume', () => {
    expect(resolveAgentSessionRuntimeStart({
      runtimeId: 'local-cli',
      runtimeSessionId: 'materialized-native-id',
    }, 'local-cli')).toEqual({
      resumeSessionId: 'materialized-native-id',
    })
  })
})

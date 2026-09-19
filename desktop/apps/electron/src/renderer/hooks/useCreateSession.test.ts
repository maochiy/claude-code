import { describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import { applyInitialAgentSessionMode } from './useCreateSession'

const META: AgentSessionMeta = {
  id: 'session-new',
  title: '新会话',
  createdAt: 1,
  updatedAt: 1,
}

describe('新 Code 会话初始模式', () => {
  test('Given 首页选择 Plan When 创建会话 Then 首次发送前持久化原生计划模式', async () => {
    const updateSessionPermissionMode = mock(async () => {})
    const updateSessionPlanMode = mock(async () => {})

    const result = await applyInitialAgentSessionMode(META, 'plan', {
      updateSessionPermissionMode,
      updateSessionPlanMode,
    })

    expect(updateSessionPlanMode).toHaveBeenCalledWith('session-new', true)
    expect(updateSessionPermissionMode).not.toHaveBeenCalled()
    expect(result).toMatchObject({ permissionMode: 'default', planModeEnabled: true })
  })

  test('Given 首页选择 Auto When 创建会话 Then 首次发送前持久化原生 Auto 模式', async () => {
    const updateSessionPermissionMode = mock(async () => {})
    const updateSessionPlanMode = mock(async () => {})

    const result = await applyInitialAgentSessionMode(META, 'auto', {
      updateSessionPermissionMode,
      updateSessionPlanMode,
    })

    expect(updateSessionPermissionMode).toHaveBeenCalledWith('session-new', 'auto')
    expect(updateSessionPlanMode).not.toHaveBeenCalled()
    expect(result).toMatchObject({ permissionMode: 'auto', planModeEnabled: false })
  })
})

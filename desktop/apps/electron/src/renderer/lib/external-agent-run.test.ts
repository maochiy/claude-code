import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@proma/shared'
import { buildExternalAgentRunActivation } from './external-agent-run'
import type { ExternalAgentRunTab } from './external-agent-run'

const session: AgentSessionMeta = {
  id: 'agent-1',
  title: '飞书任务',
  channelId: 'channel-1',
  workspaceId: 'workspace-1',
  createdAt: 1,
  updatedAt: 2,
}

describe('外部 Agent 运行激活', () => {
  test('Given 飞书触发的新会话 When 前端收到运行开始事件 Then 打开并激活 Agent 标签', () => {
    const result = buildExternalAgentRunActivation({
      tabs: [],
      sessions: [session],
      sessionId: session.id,
      startedAt: 100,
      modelId: 'claude-sonnet-4-6',
    })

    expect(result.tabs).toEqual([
      { id: session.id, type: 'agent', sessionId: session.id, title: session.title },
    ])
    expect(result.activeTabId).toBe(session.id)
    expect(result.workspaceId).toBe(session.workspaceId)
    expect(result.streamState).toMatchObject({
      running: true,
      model: 'claude-sonnet-4-6',
      startedAt: 100,
    })
  })

  test('Given 会话标签已存在 When 再次收到外部运行开始事件 Then 复用原标签并保留已有工具活动', () => {
    const tabs: ExternalAgentRunTab[] = [
      { id: session.id, type: 'agent', sessionId: session.id, title: session.title },
    ]
    const currentStreamState = {
      running: true,
      content: '已有输出',
      toolActivities: [{
        toolUseId: 'tool-1',
        toolName: 'Bash',
        input: {},
        done: false,
      }],
      model: 'old-model',
    }

    const result = buildExternalAgentRunActivation({
      tabs,
      sessions: [session],
      sessionId: session.id,
      startedAt: 200,
      currentStreamState,
    })

    expect(result.tabs).toEqual(tabs)
    expect(result.activeTabId).toBe(session.id)
    expect(result.streamState.toolActivities).toBe(currentStreamState.toolActivities)
    expect(result.streamState.content).toBe('已有输出')
    expect(result.streamState.startedAt).toBe(200)
  })

  test('Given 会话不在本地 sessions 列表中 When 激活 Then 使用 fallback 标题', () => {
    const result = buildExternalAgentRunActivation({
      tabs: [],
      sessions: [],
      sessionId: 'unknown-session',
      startedAt: 300,
    })

    expect(result.title).toBe('新 Agent 会话')
    expect(result.tabs[0]!.title).toBe('新 Agent 会话')
    expect(result.activeTabId).toBe('unknown-session')
    expect(result.workspaceId).toBeUndefined()
  })

  test('Given 无 currentStreamState When 激活 Then streamState 使用空默认值', () => {
    const result = buildExternalAgentRunActivation({
      tabs: [],
      sessions: [session],
      sessionId: session.id,
      startedAt: 400,
    })

    expect(result.streamState.running).toBe(true)
    expect(result.streamState.content).toBe('')
    expect(result.streamState.toolActivities).toEqual([])
    expect(result.streamState.model).toBeUndefined()
    expect(result.streamState.startedAt).toBe(400)
  })

  test('Given 当前已打开其他会话 When 计算外部运行激活 Then 只替换当前入口不叠加标签', () => {
    const tabs: ExternalAgentRunTab[] = [
      { id: 'chat-1', type: 'chat', sessionId: 'chat-1', title: '对话' },
    ]
    const result = buildExternalAgentRunActivation({
      tabs,
      sessions: [session],
      sessionId: session.id,
      startedAt: 500,
    })

    expect(result.tabs).toEqual([
      { id: session.id, type: 'agent', sessionId: session.id, title: session.title },
    ])
    expect(result.activeTabId).toBe(session.id)
  })

  test('Given 残留多个入口且目标会话已存在 When 计算外部运行激活 Then 只保留该会话', () => {
    const tabs: ExternalAgentRunTab[] = [
      { id: 'chat-1', type: 'chat', sessionId: 'chat-1', title: '对话' },
      { id: session.id, type: 'agent', sessionId: session.id, title: session.title },
    ]
    const result = buildExternalAgentRunActivation({
      tabs,
      sessions: [session],
      sessionId: session.id,
      startedAt: 600,
    })

    expect(result.tabs).toEqual([
      { id: session.id, type: 'agent', sessionId: session.id, title: session.title },
    ])
    expect(result.activeTabId).toBe(session.id)
  })
})

import { describe, expect, test } from 'bun:test'
import {
  closeSessionTabs,
  closeTab,
  filterRestorableSessionTabs,
  getPersistableTabState,
  isHomeLanding,
  openTab,
  SCRATCH_PAD_ID,
  TUTORIAL_TAB_ID,
  type TabItem,
} from './tab-atoms'

const chatTab: TabItem = {
  id: 'chat-1',
  type: 'chat',
  sessionId: 'chat-1',
  title: '对话',
}

const agentTab: TabItem = {
  id: 'agent-1',
  type: 'agent',
  sessionId: 'agent-1',
  title: '任务',
}

describe('当前工作区入口', () => {
  test('Given 主页空态 When 打开 Agent 会话 Then 只保留当前会话入口', () => {
    const result = openTab([], {
      type: 'agent',
      sessionId: agentTab.sessionId,
      title: agentTab.title,
    })

    expect(result.tabs).toEqual([agentTab])
    expect(result.activeTabId).toBe(agentTab.id)
    expect(isHomeLanding(result.tabs, result.activeTabId)).toBe(false)
  })

  test('Given 已打开 Chat 会话 When 再打开另一个 Agent 会话 Then 替换当前入口而不是叠加', () => {
    const result = openTab([chatTab], {
      type: 'agent',
      sessionId: agentTab.sessionId,
      title: agentTab.title,
    })

    expect(result.tabs).toEqual([agentTab])
    expect(result.activeTabId).toBe(agentTab.id)
  })

  test('Given 打开草稿本 When 查看主区 Then 只显示草稿入口', () => {
    const result = openTab([agentTab], {
      type: 'scratch',
      sessionId: SCRATCH_PAD_ID,
      title: 'Scratch Pad',
    })

    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]!.id).toBe(SCRATCH_PAD_ID)
    expect(result.activeTabId).toBe(SCRATCH_PAD_ID)
    expect(isHomeLanding(result.tabs, result.activeTabId)).toBe(false)
  })

  test('Given 当前只有一个会话 When 关闭该入口 Then 回到主页空态', () => {
    const result = closeTab([agentTab], agentTab.id, agentTab.id)

    expect(result.tabs).toEqual([])
    expect(result.activeTabId).toBeNull()
    expect(isHomeLanding(result.tabs, result.activeTabId)).toBe(true)
  })

  test('Given 当前入口是草稿或教程 When 持久化 Then 不写入 settings', () => {
    const scratchState = getPersistableTabState(
      [{ id: SCRATCH_PAD_ID, type: 'scratch', sessionId: SCRATCH_PAD_ID, title: 'Scratch Pad' }],
      SCRATCH_PAD_ID,
    )
    const tutorialState = getPersistableTabState(
      [{ id: TUTORIAL_TAB_ID, type: 'tutorial', sessionId: TUTORIAL_TAB_ID, title: 'Xcodes 使用教程' }],
      TUTORIAL_TAB_ID,
    )

    expect(scratchState).toEqual({ tabs: [], activeTabId: null })
    expect(tutorialState).toEqual({ tabs: [], activeTabId: null })
  })

  test('Given 当前入口是会话 When 持久化 Then 只保留该会话', () => {
    expect(getPersistableTabState([agentTab], agentTab.id)).toEqual({
      tabs: [agentTab],
      activeTabId: agentTab.id,
    })
  })

  test('Given 当前入口是草稿本 When 归档其他会话 Then 草稿入口保持打开', () => {
    const scratchTab: TabItem = {
      id: SCRATCH_PAD_ID,
      type: 'scratch',
      sessionId: SCRATCH_PAD_ID,
      title: 'Scratch Pad',
    }
    const result = closeSessionTabs([scratchTab], SCRATCH_PAD_ID, [agentTab.sessionId])

    expect(result.tabs).toEqual([scratchTab])
    expect(result.activeTabId).toBe(SCRATCH_PAD_ID)
    expect(isHomeLanding(result.tabs, result.activeTabId)).toBe(false)
  })

  test('Given 当前入口是被删除的会话 When 关闭这些入口 Then 回到主页空态', () => {
    const result = closeSessionTabs([agentTab], agentTab.id, [agentTab.sessionId])

    expect(result.tabs).toEqual([])
    expect(result.activeTabId).toBeNull()
    expect(isHomeLanding(result.tabs, result.activeTabId)).toBe(true)
  })

  test('Given 当前入口是空白草稿会话 When 持久化 Then 不写入 settings', () => {
    expect(getPersistableTabState([agentTab], agentTab.id, new Set([agentTab.sessionId]))).toEqual({
      tabs: [],
      activeTabId: null,
    })
  })

  test('Given 启动恢复包含草稿与无效入口 When 过滤 Then 只保留真实会话', () => {
    const restored = filterRestorableSessionTabs(
      [
        agentTab,
        chatTab,
        { id: SCRATCH_PAD_ID, type: 'scratch', sessionId: SCRATCH_PAD_ID, title: 'Scratch Pad' },
        { id: 'missing', type: 'agent', sessionId: 'missing', title: '已删除' },
      ],
      new Set([agentTab.sessionId, chatTab.sessionId]),
      new Set([agentTab.sessionId]),
    )

    expect(restored).toEqual([chatTab])
  })
})

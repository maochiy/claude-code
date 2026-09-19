import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { publishPlanDocumentAtom } from './plan-document'
import {
  agentDiffPanelTabAtom,
  agentSidePanelOpenAtom,
  agentSidePanelStackAtom,
  agentSidePanelTabsAtom,
  closeAgentSidePanelAtom,
  closeAgentSidePanelPaneAtom,
  closeAgentSidePanelTabAtom,
  createAgentTerminalTab,
  currentAgentSessionIdAtom,
  openAgentSidePanelAtom,
  openAgentSidePanelTabAtom,
} from './agent-atoms'

function setup() {
  const store = createStore()
  store.set(currentAgentSessionIdAtom, 'a')
  return store
}

describe('计划与后台任务独立堆叠', () => {
  test.each([['plan', 'tasks'], ['tasks', 'plan']] as const)(
    'Given 打开 %s When 打开 %s Then 按打开顺序上下并存且重复点击不复制面板',
    (first, second) => {
      const store = setup()
      store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: first })
      store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: second })
      store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: first })
      expect(store.get(agentSidePanelStackAtom)).toEqual([first, second])
      expect(store.get(agentSidePanelOpenAtom)).toBe(true)
    },
  )

  test.each(['plan', 'tasks'] as const)('Given 两个面板 When 关闭 %s Then 只留下另一个，缓存不销毁', (tab) => {
    const store = setup()
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: 'plan' })
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: 'tasks' })
    store.set(closeAgentSidePanelPaneAtom, { sessionId: 'a', tab })
    const remaining = tab === 'plan' ? 'tasks' : 'plan'
    expect(store.get(agentSidePanelStackAtom)).toEqual([remaining])
    expect(store.get(agentDiffPanelTabAtom).get('a')).toBe(remaining)
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
    expect(store.get(agentSidePanelTabsAtom).get('a')).toEqual(['plan', 'tasks'])
    store.set(closeAgentSidePanelPaneAtom, { sessionId: 'a', tab: remaining })
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab })
    expect(store.get(agentSidePanelStackAtom)).toEqual([tab])
  })

  test('Given 面板已堆叠 When 切换会话且旧会话异步请求打开 Then 新会话保持关闭，回到旧会话不自动恢复', () => {
    const store = setup()
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: 'tasks' })
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: 'plan' })
    store.set(currentAgentSessionIdAtom, 'b')
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: 'plan' })
    store.set(closeAgentSidePanelPaneAtom, { sessionId: 'a', tab: 'plan' })
    expect(store.get(agentSidePanelStackAtom)).toEqual([])
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    store.set(currentAgentSessionIdAtom, 'a')
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: 'tasks' })
    expect(store.get(agentSidePanelStackAtom)).toEqual(['tasks'])
  })

  test('Given 堆叠面板 When 打开文件或终端 Then 切换为独立功能，关闭终端面板保留终端', () => {
    const store = setup()
    const terminal = createAgentTerminalTab('terminal-a')
    for (const tab of ['plan', 'tasks', 'files', terminal] as const) {
      store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab })
    }
    expect(store.get(agentSidePanelStackAtom)).toEqual([terminal])
    store.set(closeAgentSidePanelPaneAtom, { sessionId: 'a', tab: terminal })
    expect(store.get(agentSidePanelTabsAtom).get('a')).toContain(terminal)
    store.set(openAgentSidePanelAtom, 'a')
    expect(store.get(agentSidePanelStackAtom)).toEqual([terminal])
    store.set(closeAgentSidePanelAtom, 'a')
    expect(store.get(agentSidePanelStackAtom)).toEqual([])
  })

  test('Given 保留后台任务面板 When 重开计划且另一会话更新 Then 恢复双面板且不抢占当前内容', () => {
    const store = setup()
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: 'tasks' })
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: 'plan' })
    store.set(closeAgentSidePanelPaneAtom, { sessionId: 'a', tab: 'plan' })
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: 'plan' })
    store.set(openAgentSidePanelTabAtom, { sessionId: 'b', tab: 'files' })
    expect(store.get(agentSidePanelStackAtom)).toEqual(['tasks', 'plan'])
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
    expect(store.get(agentDiffPanelTabAtom).get('a')).toBe('plan')
  })

  test('Given 后台任务面板正在显示 When 模型生成计划 Then 自动追加计划，关闭后增量不重新弹开', () => {
    const store = setup()
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: 'tasks' })
    store.set(publishPlanDocumentAtom, { sessionId: 'a', document: { id: 'p1', content: '# 计划' }, autoOpen: true })
    expect(store.get(agentSidePanelStackAtom)).toEqual(['tasks', 'plan'])
    store.set(closeAgentSidePanelPaneAtom, { sessionId: 'a', tab: 'plan' })
    store.set(publishPlanDocumentAtom, { sessionId: 'a', document: { id: 'p1', content: '# 计划\n第一步' }, autoOpen: true })
    expect(store.get(agentSidePanelStackAtom)).toEqual(['tasks'])
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
  })

  test('Given 两个可见面板 When 删除一个功能 Tab Then 剩余面板仍可见', () => {
    const store = setup()
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: 'plan' })
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: 'tasks' })
    store.set(closeAgentSidePanelTabAtom, { sessionId: 'a', tab: 'tasks' })
    expect(store.get(agentSidePanelStackAtom)).toEqual(['plan'])
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
  })
})

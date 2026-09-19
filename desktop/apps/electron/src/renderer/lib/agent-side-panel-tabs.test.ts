import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  AGENT_SIDE_PANEL_DEFAULT_WIDTH,
  agentDiffPanelTabAtom,
  agentFocusedExecutionNodeAtom,
  agentSidePanelOpenAtom,
  agentSidePanelTabsAtom,
  agentSidePanelWidthAtom,
  agentTerminalTabSnapshotsAtom,
  closeAgentSidePanelAtom,
  closeAgentSidePanelTabAtom,
  createAgentExecutionNodeTab,
  createAgentTerminalTab,
  currentAgentSessionIdAtom,
  agentLastTerminalTabAtom,
  getAgentExecutionNodeId,
  getAgentTerminalSessionId,
  isAgentExecutionNodeTab,
  isAgentTerminalTab,
  openAgentSidePanelAtom,
  openAgentSidePanelTabAtom,
  reorderAgentSidePanelTabsAtom,
} from '@/atoms/agent-atoms'
import { getAvailableAgentSidePanelTabs } from './agent-side-panel-tabs'

const SESSION_ID = 'dynamic-side-panel-test'

describe('右侧动态功能区状态', () => {
  test('Given 手动打开功能区 When 没有任何 Tab Then 默认打开「工作区文件」', () => {
    const store = createStore()

    store.set(openAgentSidePanelAtom, SESSION_ID)

    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual(['files'])
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBe('files')
  })

  test('Given 空面板 When 打开指定 Tab Then 创建并激活唯一动态 Tab', () => {
    const store = createStore()

    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'changes' })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'changes' })

    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual(['changes'])
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBe('changes')
  })

  test('Given 多个动态 Tabs When 关闭最后一个 Then 整个面板收起', () => {
    const store = createStore()
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'files' })
    store.set(openAgentSidePanelTabAtom, {
      sessionId: SESSION_ID,
      tab: 'execution',
      focusedExecutionNodeId: 'node-1',
    })

    store.set(closeAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'execution' })
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBeUndefined()
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    expect(store.get(agentFocusedExecutionNodeAtom).has(SESSION_ID)).toBe(false)

    store.set(closeAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'files' })
    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual([])
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
  })

  test('Given 已打开 Tabs When 拖动排序 Then 保存新的顺序', () => {
    const store = createStore()
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'files' })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'changes' })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'browser' })

    store.set(reorderAgentSidePanelTabsAtom, {
      sessionId: SESSION_ID,
      source: 'changes',
      target: 'files',
    })

    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual([
      'changes',
      'files',
      'browser',
    ])
  })

  test('Given 点击不同执行节点 When 打开动态 Tabs Then 每个节点拥有独立且可还原的 Tab', () => {
    const store = createStore()
    const firstNodeTab = createAgentExecutionNodeTab('node-1')
    const secondNodeTab = createAgentExecutionNodeTab('node-2')

    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: firstNodeTab })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: secondNodeTab })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: firstNodeTab })

    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual([
      firstNodeTab,
      secondNodeTab,
    ])
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBe(firstNodeTab)
    expect(isAgentExecutionNodeTab(firstNodeTab)).toBe(true)
    expect(getAgentExecutionNodeId(secondNodeTab)).toBe('node-2')
  })

  test('Given 不同 Runtime 复用了节点 ID When 创建节点 Tabs Then 两个详情 Tab 身份互不冲突', () => {
    const firstRuntimeTab = createAgentExecutionNodeTab('node-1', 'runtime-a')
    const secondRuntimeTab = createAgentExecutionNodeTab('node-1', 'runtime-b')

    expect(firstRuntimeTab).not.toBe(secondRuntimeTab)
    expect(getAgentExecutionNodeId(firstRuntimeTab)).toBe('node-1')
    expect(getAgentExecutionNodeId(secondRuntimeTab)).toBe('node-1')
  })

  test('Given 已打开多个执行节点 Tabs When 关闭其中一个 Then 保留其他节点 Tab', () => {
    const store = createStore()
    const firstNodeTab = createAgentExecutionNodeTab('node-1')
    const secondNodeTab = createAgentExecutionNodeTab('node-2')

    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: firstNodeTab })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: secondNodeTab })
    store.set(closeAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: firstNodeTab })

    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual([secondNodeTab])
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBe(secondNodeTab)
  })

  test('Given 创建两个终端会话 When 打开动态 Tabs Then 每个 PTY 使用独立 Tab 和快照', () => {
    const store = createStore()
    const firstTab = createAgentTerminalTab('terminal-1')
    const secondTab = createAgentTerminalTab('terminal-2')
    const createSnapshot = (id: string, cwd: string) => ({
      id,
      conversationId: SESSION_ID,
      cwd,
      shellName: 'zsh',
      shellKind: 'zsh' as const,
      cols: 80,
      rows: 24,
      output: '',
      outputSequence: 0,
      truncated: false,
      alternateScreen: false,
    })

    store.set(openAgentSidePanelTabAtom, {
      sessionId: SESSION_ID,
      tab: firstTab,
      terminalSnapshot: createSnapshot('terminal-1', '/tmp/project-a'),
    })
    store.set(openAgentSidePanelTabAtom, {
      sessionId: SESSION_ID,
      tab: secondTab,
      terminalSnapshot: createSnapshot('terminal-2', '/tmp/project-b'),
    })

    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual([
      firstTab,
      secondTab,
    ])
    expect(isAgentTerminalTab(firstTab)).toBe(true)
    expect(getAgentTerminalSessionId(secondTab)).toBe('terminal-2')
    expect(
      store.get(agentTerminalTabSnapshotsAtom).get(SESSION_ID)?.get(firstTab)?.cwd,
    ).toBe('/tmp/project-a')

    store.set(closeAgentSidePanelTabAtom, {
      sessionId: SESSION_ID,
      tab: firstTab,
    })
    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual([secondTab])
    expect(
      store.get(agentTerminalTabSnapshotsAtom).get(SESSION_ID)?.has(firstTab),
    ).toBe(false)
  })

  test('Given 已打开 Tabs When 收起并再次打开功能区 Then 恢复原 Tabs 和激活项', () => {
    const store = createStore()
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'changes' })
    store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: 'files' })

    store.set(closeAgentSidePanelAtom, SESSION_ID)
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual(['changes', 'files'])
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBe('files')

    store.set(openAgentSidePanelAtom, SESSION_ID)
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual(['changes', 'files'])
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBe('files')
  })

  test('Given 功能区已收起且宽度较小 When 再次打开 Then 使用默认宽度', () => {
    const store = createStore()
    store.set(agentSidePanelWidthAtom, 360)
    store.set(closeAgentSidePanelAtom, SESSION_ID)

    store.set(openAgentSidePanelAtom, SESSION_ID)

    expect(store.get(agentSidePanelWidthAtom)).toBe(AGENT_SIDE_PANEL_DEFAULT_WIDTH)
  })

  test('Given 当前会话没有 Tabs When 打开功能区 Then 默认补开「工作区文件」', () => {
    const store = createStore()
    store.set(closeAgentSidePanelAtom, SESSION_ID)

    store.set(openAgentSidePanelAtom, SESSION_ID)

    expect(store.get(agentSidePanelTabsAtom).get(SESSION_ID)).toEqual(['files'])
    expect(store.get(agentDiffPanelTabAtom).get(SESSION_ID)).toBe('files')
  })
})

describe('右侧功能区加号菜单', () => {
  test('Given 部分功能已打开 When 生成可选项 Then 只返回尚未打开且当前可用的功能', () => {
    expect(getAvailableAgentSidePanelTabs({
      openTabs: ['files', 'changes'],
      hasExecutionGraph: true,
      hasPlan: true,
      hasSideChat: true,
    })).toEqual(['browser', 'plan', 'execution', 'chat', 'terminal'])
  })

  test('Given 没有执行图和侧边问答 When 生成可选项 Then 不显示执行与问答', () => {
    expect(getAvailableAgentSidePanelTabs({
      openTabs: [],
      hasExecutionGraph: false,
      hasPlan: false,
      hasSideChat: false,
    })).toEqual(['browser', 'files', 'changes', 'terminal'])
  })

  test('Given 执行节点动态 Tab 已打开 When 生成加号菜单 Then 不影响静态功能候选项', () => {
    expect(getAvailableAgentSidePanelTabs({
      openTabs: [createAgentExecutionNodeTab('node-1')],
      hasExecutionGraph: true,
      hasPlan: false,
      hasSideChat: false,
    })).toEqual(['browser', 'files', 'changes', 'execution', 'terminal'])
  })

  test('Given 当前存在计划 When 子智能体不存在 Then 加号菜单仍可单独打开计划', () => {
    expect(getAvailableAgentSidePanelTabs({
      openTabs: [],
      hasExecutionGraph: false,
      hasPlan: true,
      hasSideChat: false,
    })).toEqual(['browser', 'files', 'changes', 'plan', 'terminal'])
  })

  test('Given 当前会话有后台任务 When 生成可选项 Then 可打开独立后台任务面板', () => {
    expect(getAvailableAgentSidePanelTabs({
      openTabs: [],
      hasExecutionGraph: false,
      hasPlan: false,
      hasSideChat: false,
      hasBackgroundTasks: true,
    })).toEqual(['browser', 'files', 'changes', 'tasks', 'terminal'])
  })
})


describe('独立面板与会话终端生命周期', () => {
  test('Given 会话 A 打开终端 When 收起、切换 B 再返回 A Then 面板保持关闭且终端可恢复', () => {
    const store = createStore()
    const terminalA = createAgentTerminalTab('pty-a')
    const terminalB = createAgentTerminalTab('pty-b')
    store.set(currentAgentSessionIdAtom, 'a')
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: terminalA })
    store.set(closeAgentSidePanelAtom, 'a')
    expect(store.get(agentSidePanelTabsAtom).get('a')).toEqual([terminalA])
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: terminalA })
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
    store.set(currentAgentSessionIdAtom, 'b')
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    store.set(openAgentSidePanelTabAtom, { sessionId: 'b', tab: terminalB })
    store.set(currentAgentSessionIdAtom, 'a')
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    expect(store.get(agentSidePanelTabsAtom).get('a')).toEqual([terminalA])
    expect(store.get(agentSidePanelTabsAtom).get('b')).toEqual([terminalB])
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: terminalA })
    expect(store.get(agentDiffPanelTabAtom).get('a')).toBe(terminalA)
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
  })

  test.each(['files', 'changes'] as const)('Given 打开 %s When 切换会话 Then 收起面板', (tab) => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'a')
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab })
    store.set(currentAgentSessionIdAtom, 'b')
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    store.set(currentAgentSessionIdAtom, 'a')
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
  })

  test('Given 当前会话打开面板 When 同步同一会话或离开 Agent Then 重复同步不关闭但离开时关闭', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'a')
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: 'files' })
    store.set(currentAgentSessionIdAtom, 'a')
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
    store.set(currentAgentSessionIdAtom, null)
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    store.set(currentAgentSessionIdAtom, 'a')
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
  })

  test('Given 创建终端尚未返回 When 已切换会话后创建完成 Then 保存终端但不弹出当前面板', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'b')
    store.set(openAgentSidePanelTabAtom, { sessionId: 'a', tab: createAgentTerminalTab('delayed') })
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    expect(store.get(agentSidePanelTabsAtom).get('a')).toEqual([createAgentTerminalTab('delayed')])
  })

  test('Given 两个终端与文件面板 When 切回终端 Then 记住最后使用的终端而非首个', () => {
    const store = createStore()
    const first = createAgentTerminalTab('first')
    const second = createAgentTerminalTab('second')
    store.set(currentAgentSessionIdAtom, SESSION_ID)
    for (const tab of [first, second, 'files'] as const) {
      store.set(openAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab })
    }
    expect(store.get(agentLastTerminalTabAtom).get(SESSION_ID)).toBe(second)
    store.set(closeAgentSidePanelTabAtom, { sessionId: SESSION_ID, tab: second })
    expect(store.get(agentLastTerminalTabAtom).get(SESSION_ID)).toBe(first)
  })
})

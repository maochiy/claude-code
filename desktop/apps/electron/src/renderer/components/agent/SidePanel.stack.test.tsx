import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  agentDiffPanelTabAtom,
  agentSidePanelOpenAtom,
  agentSidePanelStackAtom,
  agentSidePanelTabsAtom,
  closeAgentSidePanelPaneAtom,
  currentAgentSessionIdAtom,
} from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { RightSidePanel } from '@/components/app-shell/RightSidePanel'
import { SidePanel } from './SidePanel'

const SESSION_ID = 'stacked-panel-session'

function renderPanel(input: {
  activeTab: 'plan' | 'tasks'
  auxiliaryTab?: 'plan' | 'tasks'
}): string {
  const store = createStore()
  store.set(currentAgentSessionIdAtom, SESSION_ID)
  store.set(agentSidePanelOpenAtom, true)

  return renderToStaticMarkup(
    <Provider store={store}>
      <SidePanel
        sessionId={SESSION_ID}
        sessionPath={null}
        activeTab={input.activeTab}
        auxiliaryTab={input.auxiliaryTab}
        onTabChange={() => {}}
        openTabs={['plan', 'tasks']}
        onOpenTab={() => {}}
        onCreateTerminal={() => {}}
        onCloseTab={() => {}}
        onClosePanel={() => {}}
        onCloseAuxiliaryPane={() => {}}
        onReorderTabs={() => {}}
        width={420}
      />
    </Provider>,
  )
}

function createStackedRightPanelStore() {
  const store = createStore()
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, SESSION_ID)
  store.set(agentSidePanelOpenAtom, true)
  store.set(agentSidePanelTabsAtom, new Map([[SESSION_ID, ['plan', 'tasks']]]))
  store.set(agentDiffPanelTabAtom, new Map([[SESSION_ID, 'tasks']]))
  store.set(agentSidePanelStackAtom, ['plan', 'tasks'])
  return store
}

function renderRightPanel(store: ReturnType<typeof createStackedRightPanelStore>): string {
  return renderToStaticMarkup(
    <Provider store={store}>
      <RightSidePanel width={420} />
    </Provider>,
  )
}

describe('SidePanel 计划与后台任务独立面板', () => {
  test('Given 计划在上且后台任务在下 When 渲染 Then 生成两个等分且顺序正确的 surface', () => {
    const html = renderPanel({ activeTab: 'plan', auxiliaryTab: 'tasks' })
    const planIndex = html.indexOf('data-side-panel-pane="plan"')
    const tasksIndex = html.indexOf('data-side-panel-pane="tasks"')

    expect(html).toContain('aria-hidden="false"')
    expect(planIndex).toBeGreaterThan(-1)
    expect(tasksIndex).toBeGreaterThan(planIndex)
    expect(html.match(/data-side-panel-pane=/g)).toHaveLength(2)
    expect(html.match(/data-side-panel-size="equal"/g)).toHaveLength(2)
    expect(html).toContain('data-side-panel-auxiliary="true"')
    expect(html.match(/aria-label="展开面板"/g)).toHaveLength(2)
  })

  test('Given 辅助面板已关闭 When 后台任务成为主面板 Then 单个面板自动占满可用高度', () => {
    const html = renderPanel({ activeTab: 'tasks' })

    expect(html.match(/data-side-panel-pane=/g)).toHaveLength(1)
    expect(html).toContain('data-side-panel-pane="tasks"')
    expect(html).not.toContain('data-side-panel-auxiliary')
    expect(html).toContain('flex-1')
  })

  test('Given 双面板 When 渲染常驻区域 Then 浏览器层只存在于主面板且不会重复实例化', () => {
    const html = renderPanel({ activeTab: 'plan', auxiliaryTab: 'tasks' })

    expect(html.match(/data-persistent-browser-layer=/g)).toHaveLength(1)
    expect(html).toContain('style="top:34px"')
  })

  test('Given 双面板 When 关闭上方主面板 Then 下方面板成为唯一主面板并占满高度', () => {
    const store = createStackedRightPanelStore()
    store.set(closeAgentSidePanelPaneAtom, { sessionId: SESSION_ID, tab: 'plan' })
    const html = renderRightPanel(store)

    expect(html.match(/data-side-panel-pane=/g)).toHaveLength(1)
    expect(html).toContain('data-side-panel-pane="tasks"')
    expect(html).not.toContain('data-side-panel-auxiliary')
  })

  test('Given 双面板 When 关闭下方辅助面板 Then 上方面板成为唯一主面板并占满高度', () => {
    const store = createStackedRightPanelStore()
    store.set(closeAgentSidePanelPaneAtom, { sessionId: SESSION_ID, tab: 'tasks' })
    const html = renderRightPanel(store)

    expect(html.match(/data-side-panel-pane=/g)).toHaveLength(1)
    expect(html).toContain('data-side-panel-pane="plan"')
    expect(html).not.toContain('data-side-panel-auxiliary')
  })
})

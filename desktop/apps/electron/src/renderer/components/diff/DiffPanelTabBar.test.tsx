import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'
import {
  createAgentExecutionNodeTab,
  createAgentTerminalTab,
  currentAgentSessionIdAtom,
} from '@/atoms/agent-atoms'
import {
  DiffPanelTabBar,
} from './DiffPanelTabBar'

describe('DiffPanelTabBar 右侧动态 Tab 栏', () => {
  test('Given 已打开文件与改动面板 When 切换语言 Then 标签和操作文案同步更新', () => {
    const store = createStore()
    const render = () => renderToStaticMarkup(
      <Provider store={store}>
        <DiffPanelTabBar
          activeTab="files"
          openTabs={['files', 'changes']}
          availableTabs={['terminal']}
          onTabChange={() => undefined}
          onTabClose={() => undefined}
          onTabAdd={() => undefined}
          onTabReorder={() => undefined}
          onClosePanel={() => undefined}
        />
      </Provider>,
    )
    expect(render()).toContain('关闭面板')
    store.set(settingsPreferencesAtom, (previous) => ({ ...previous, interfaceLanguage: 'en' }))
    const english = render()
    expect(english).toContain('Files')
    expect(english).not.toContain('Changes')
    expect(english).toContain('Close panel')
    expect(english).not.toContain('文件改动')
    store.set(settingsPreferencesAtom, (previous) => ({ ...previous, interfaceLanguage: 'zh' }))
    expect(render()).toContain('文件')
    expect(render()).not.toContain('文件改动')
  })

  test('Given 只打开一个 Tab When 渲染 Then 显示细标题行而非标签条（对齐参考桌面端）', () => {
    const store = createStore()
    const nodeTab = createAgentExecutionNodeTab('node-1')
    store.set(currentAgentSessionIdAtom, 'session-1')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <DiffPanelTabBar
          activeTab={nodeTab}
          openTabs={[nodeTab]}
          availableTabs={['files', 'changes', 'plan', 'execution']}
          onTabChange={() => undefined}
          onTabClose={() => undefined}
          onTabAdd={() => undefined}
          onTabReorder={() => undefined}
          getTabLabel={() => '布局分析'}
        />
      </Provider>,
    )

    expect(html).toContain('布局分析')
    // 单 Tab：细标题行 + 关闭按钮，非终端 Tab 不渲染加号（对齐参考 Files 面板头部）
    expect(html).not.toContain('draggable="true"')
    expect(html).not.toContain('aria-label="打开其他功能"')
    expect(html).toContain('aria-label="关闭布局分析"')
  })

  test('Given 已打开终端、文件和改动 When 查看终端 Then 标签栏只展示同会话的终端实例', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-1')

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <DiffPanelTabBar
          activeTab={createAgentTerminalTab('one')}
          openTabs={['files', createAgentTerminalTab('one'), 'changes', createAgentTerminalTab('two')]}
          availableTabs={['plan', 'execution']}
          onTabChange={() => undefined}
          onTabClose={() => undefined}
          onTabAdd={() => undefined}
          onTabReorder={() => undefined}
        />
      </Provider>,
    )

    expect(html).not.toContain('文件')
    expect(html).not.toContain('文件改动')
    expect(html).toContain('终端')
    expect(html).toContain('draggable="true"')
    expect(html).toContain('aria-label="新建终端"')
  })
})

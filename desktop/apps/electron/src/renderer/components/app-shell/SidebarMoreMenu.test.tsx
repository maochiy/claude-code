import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'
import { sidebarMoreExpandedAtom } from '@/atoms/sidebar-atoms'
import { SIDEBAR_MORE_ITEM_IDS, SidebarMoreMenu } from './SidebarMoreMenu'

describe('侧栏更多菜单', () => {
  test('Given 更多菜单展开 When 渲染 Then 只提供任务面板与定时任务两个轻量入口', () => {
    const store = createStore()
    store.set(sidebarMoreExpandedAtom, true)
    store.set(settingsPreferencesAtom, (previous) => ({ ...previous, interfaceLanguage: 'zh' }))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <SidebarMoreMenu onOpenTaskboard={() => undefined} onOpenAutomations={() => undefined} />
      </Provider>,
    )

    expect(SIDEBAR_MORE_ITEM_IDS).toEqual(['taskboard', 'automations'])
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).not.toContain('data-sidebar-more-inline')
  })
})

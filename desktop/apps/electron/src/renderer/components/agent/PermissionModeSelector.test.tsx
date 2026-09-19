import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentPermissionModeMapAtom } from '@/atoms/agent-atoms'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'
import type { PromaApprovalMode } from '@proma/shared'
import {
  PermissionModeOption,
  PermissionModeSelector,
} from './PermissionModeSelector'

function renderMode(mode: PromaApprovalMode): string {
  const store = createStore()
  store.set(agentPermissionModeMapAtom, new Map([['session-mode', mode]]))
  store.set(settingsPreferencesAtom, (previous) => ({ ...previous, interfaceLanguage: 'en' }))
  return renderToStaticMarkup(
    <Provider store={store}>
      <PermissionModeSelector sessionId="session-mode" />
    </Provider>,
  )
}

describe('Agent 权限模式选择器', () => {
  test('Given 已保存 dontAsk When 重开会话 Then 原生模式原样显示', () => {
    expect(renderMode('dontAsk')).toContain("Approval mode：Don&#x27;t ask")
  })

  test('Given 已保存 Auto When 当前目录尚未完成能力加载 Then 不降级为 bypass', () => {
    const html = renderMode('auto')
    expect(html).toContain('Approval mode：Auto')
    expect(html).not.toContain('Approval mode：Bypass permissions')
  })

  test('Given Runtime 明确不支持 Auto When 渲染菜单项 Then 保留入口并禁用且解释原因', () => {
    const html = renderToStaticMarkup(
      <PermissionModeOption
        index={5}
        row={{
          key: 'auto',
          label: 'Auto',
          description: 'The current model does not support Auto.',
          selected: false,
          disabled: true,
          onSelect: () => undefined,
        }}
      />,
    )

    expect(html).toContain('>Auto</span>')
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('The current model does not support Auto.')
  })
})

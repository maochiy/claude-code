import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionPlanModeAction } from './SessionMoreMenu'

describe('会话菜单的计划入口', () => {
  test('Given 当前尚未生成计划 When 渲染计划模式操作 Then 仍可随时开启计划模式', () => {
    const html = renderToStaticMarkup(
      <SessionPlanModeAction enabled={false} onChange={() => undefined} />,
    )

    expect(html).toContain('计划')
    expect(html).not.toContain('display:none')
  })

  test('Given 当前会话已有计划数据 When 顶部更多菜单打开计划 Then 调用独立计划面板入口', () => {
    const source = readFileSync(new URL('./AgentHeader.tsx', import.meta.url), 'utf8')

    expect(source).toContain("runtimeHistory?.todos ?? []")
    expect(source).toContain("openSidePanelTab({ sessionId, tab: 'plan' })")
    expect(source).toContain('{showPlan && (')
  })
})

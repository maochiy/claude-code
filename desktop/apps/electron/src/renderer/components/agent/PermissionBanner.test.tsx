import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionRequest } from '@proma/shared'
import { allPendingPermissionRequestsAtom } from '@/atoms/agent-atoms'
import { PermissionBanner } from './PermissionBanner'

const SESSION_ID = 'permission-panel-test'

function createRequest(requestId: string, command = 'rm -f proma-approval-test.txt'): PermissionRequest {
  return {
    requestId,
    sessionId: SESSION_ID,
    toolName: 'Bash',
    toolInput: { command },
    description: '执行删除命令',
    command,
    dangerLevel: 'dangerous',
  }
}

function renderPermissionBanner(requestId?: string, requests = [createRequest('request-1')]): string {
  const store = createStore()
  store.set(allPendingPermissionRequestsAtom, new Map([[SESSION_ID, requests]]))

  return renderToStaticMarkup(
    <Provider store={store}>
      <PermissionBanner sessionId={SESSION_ID} requestId={requestId} />
    </Provider>,
  )
}

describe('PermissionBanner 审批面板', () => {
  test('宽度跟随输入区域且整体高度不固定', () => {
    const html = renderPermissionBanner()

    expect(html).toContain('w-full')
    expect(html).toContain('rounded-[22px]')
    expect(html).not.toContain('mx-4')
    expect(html).not.toContain('h-[120px]')
  })

  test('审批操作按允许、始终允许、拒绝纵向呈现', () => {
    const html = renderPermissionBanner()
    const allowIndex = html.indexOf('允许一次')
    const alwaysAllowIndex = html.indexOf('本次会话始终允许')
    const denyIndex = html.indexOf('拒绝本次操作')

    expect(allowIndex).toBeGreaterThan(-1)
    expect(alwaysAllowIndex).toBeGreaterThan(allowIndex)
    expect(denyIndex).toBeGreaterThan(alwaysAllowIndex)
    expect(html).toContain('flex flex-col gap-1')
    expect(html).toContain('data-permission-decision="allow_once"')
    expect(html).toContain('data-permission-decision="allow_session"')
    expect(html).toContain('data-permission-decision="deny"')
  })

  test('关闭面板表示拒绝当前操作而不是终止 Agent', () => {
    const html = renderPermissionBanner()

    expect(html).toContain('title="拒绝当前操作"')
    expect(html).not.toContain('关闭并终止 Agent')
  })

  test('Given 跨类型排序选中指定审批 When 渲染 Then 不再固定展示权限队列首项', () => {
    const html = renderPermissionBanner('request-2', [
      createRequest('request-1', 'echo first'),
      createRequest('request-2', 'echo selected'),
    ])

    expect(html).toContain('echo selected')
    expect(html).not.toContain('echo first')
  })
})

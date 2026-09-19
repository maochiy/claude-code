import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ExitPlanModeRequest } from '@proma/shared'
import { agentPermissionModeMapAtom, allPendingExitPlanRequestsAtom } from '@/atoms/agent-atoms'
import { ExitPlanModeBanner } from './ExitPlanModeBanner'

const SESSION_ID = 'plan-panel-test'

function createRequest(requestId: string, prompt = '运行项目测试'): ExitPlanModeRequest {
  return {
    requestId,
    sessionId: SESSION_ID,
    toolInput: {},
    allowedPrompts: [
      { tool: 'Bash', prompt },
    ],
  }
}

function renderExitPlanModeBanner(requestId?: string, requests = [createRequest('plan-request-1')]): string {
  const store = createStore()
  store.set(allPendingExitPlanRequestsAtom, new Map([[SESSION_ID, requests]]))

  return renderToStaticMarkup(
    <Provider store={store}>
      <ExitPlanModeBanner sessionId={SESSION_ID} requestId={requestId} />
    </Provider>,
  )
}

describe('ExitPlanModeBanner 计划审批面板', () => {
  test('使用与权限审批相同的输入框卡片尺寸', () => {
    const html = renderExitPlanModeBanner()

    expect(html).toContain('w-full')
    expect(html).toContain('rounded-[22px]')
    expect(html).not.toContain('mx-4')
  })

  test('三个计划操作使用纵向审批列表样式', () => {
    const html = renderExitPlanModeBanner()
    const approveIndex = html.indexOf('批准并执行计划')
    const denyIndex = html.indexOf('拒绝计划')
    const feedbackIndex = html.indexOf('提供修改意见')

    expect(approveIndex).toBeGreaterThan(-1)
    expect(denyIndex).toBeGreaterThan(approveIndex)
    expect(feedbackIndex).toBeGreaterThan(denyIndex)
    expect(html).toContain('flex flex-col gap-1')
    expect(html).toContain('rounded-xl px-3 py-2.5')
    expect(html).toContain('data-plan-decision="approve"')
    expect(html).toContain('data-plan-decision="deny"')
    expect(html).toContain('data-plan-decision="feedback"')
  })

  test('Given 会话原审批模式为不询问 When 展示计划审批 Then 明确批准后的目标模式', () => {
    const store = createStore()
    store.set(agentPermissionModeMapAtom, new Map([[SESSION_ID, 'dontAsk']]))
    store.set(allPendingExitPlanRequestsAtom, new Map([[SESSION_ID, [createRequest('plan-request-mode')]]]))

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <ExitPlanModeBanner sessionId={SESSION_ID} />
      </Provider>,
    )

    expect(html).toContain('批准后切换到“不询问”')
    expect(html).not.toContain('批准并完全自动执行')
  })

  test('关闭面板表示拒绝计划而不是终止 Agent', () => {
    const html = renderExitPlanModeBanner()

    expect(html).toContain('title="拒绝当前计划"')
    expect(html).not.toContain('关闭并终止 Agent')
  })

  test('Given 调用方选中指定计划审批 When 渲染 Then 展示对应请求而非队列首项', () => {
    const html = renderExitPlanModeBanner('plan-request-2', [
      createRequest('plan-request-1', '运行第一组测试'),
      createRequest('plan-request-2', '运行选中测试'),
    ])

    expect(html).toContain('运行选中测试')
    expect(html).not.toContain('运行第一组测试')
  })
})

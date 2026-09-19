import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AskUserRequest } from '@proma/shared'
import { allPendingAskUserRequestsAtom } from '@/atoms/agent-atoms'
import { AskUserBanner } from './AskUserBanner'

const SESSION_ID = 'ask-user-panel-test'

function createRequest(requestId: string, question: string): AskUserRequest {
  return {
    requestId,
    sessionId: SESSION_ID,
    questions: [{
      question,
      options: [{ label: '继续' }, { label: '稍后' }],
    }],
    toolInput: {},
  }
}

function renderAskUserBanner(requestId?: string): string {
  const store = createStore()
  store.set(allPendingAskUserRequestsAtom, new Map([[SESSION_ID, [
    createRequest('question-1', '第一个问题'),
    createRequest('question-2', '选中的问题'),
  ]]]))

  return renderToStaticMarkup(
    <Provider store={store}>
      <AskUserBanner sessionId={SESSION_ID} requestId={requestId} />
    </Provider>,
  )
}

describe('AskUserBanner 问答面板', () => {
  test('Given 问答请求待处理 When 渲染 Then 跳过是明确的非拒绝动作', () => {
    const html = renderAskUserBanner()

    expect(html).toContain('data-ask-user-action="skip"')
    expect(html).toContain('跳过问题')
    expect(html).toContain('title="跳过问题并继续"')
    expect(html).not.toContain('拒绝当前操作')
  })

  test('Given 调用方选中指定请求 When 渲染 Then 展示对应问题而非队列首项', () => {
    const html = renderAskUserBanner('question-2')

    expect(html).toContain('选中的问题')
    expect(html).not.toContain('第一个问题')
  })
})

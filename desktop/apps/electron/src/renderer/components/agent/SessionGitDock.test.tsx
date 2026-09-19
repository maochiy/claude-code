import { describe, expect, test } from 'bun:test'
import { Children, isValidElement, type ReactNode } from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentSessionGitSummaryAtom } from '@/atoms/agent-atoms'
import { SessionGitDock } from './SessionGitDock'

interface ActionProps {
  children?: ReactNode
  onSelect?: () => void
  onClick?: () => void
  disabled?: boolean
}

// 捕获组件真实事件回调；用相同 Jotai store 重渲染模拟用户选择后的界面。
function renderActions(store: ReturnType<typeof createStore>, sessionId: string, sent: string[]): ActionProps[] {
  const actions: ActionProps[] = []
  function collect(node: ReactNode): void {
    Children.forEach(node, (child) => {
      if (!isValidElement<ActionProps>(child)) return
      if (child.props.onSelect || child.props.onClick) actions.push(child.props)
      collect(child.props.children)
    })
  }
  function Probe() {
    collect(SessionGitDock({ sessionId, sessionPath: '/repo', onCommitRequest: () => sent.push('commit'), onCreatePrRequest: () => sent.push('pr') }))
    return null
  }
  renderToStaticMarkup(<Provider store={store}><Probe /></Provider>)
  return actions
}

function setupStore() {
  const store = createStore()
  const summary = { repoStatus: { isRepo: true, branch: 'feature', hasChanges: true, remoteUrl: null, aheadCount: 1 }, filesChanged: 2, additions: 4, deletions: 1, updatedAt: 0 }
  store.set(agentSessionGitSummaryAtom, new Map([['a', summary], ['b', summary]]))
  return store
}

describe('Git 操作选择与发送', () => {
  test('Given 默认创建 PR When 下拉选择提交变更 Then 只更新主按钮，再点击才发送一次', () => {
    const store = setupStore()
    const sent: string[] = []
    renderActions(store, 'a', sent).filter((action) => action.onSelect)[1]?.onSelect?.()
    expect(sent).toEqual([])
    const actions = renderActions(store, 'a', sent)
    const primary = actions.find((action) => action.children === '提交变更')
    expect(primary).toBeDefined()
    expect(primary?.disabled).toBe(false)
    primary?.onClick?.()
    expect(sent).toEqual(['commit'])
  })

  test('Given A 已改为提交变更 When 切换 B 再回 A Then 两个会话独立记住选择且不发送', () => {
    const store = setupStore()
    const sent: string[] = []
    renderActions(store, 'a', sent).filter((action) => action.onSelect)[1]?.onSelect?.()
    expect(renderActions(store, 'b', sent).some((action) => action.children === '创建 PR' && action.onClick)).toBe(true)
    expect(renderActions(store, 'a', sent).some((action) => action.children === '提交变更' && action.onClick)).toBe(true)
    expect(sent).toEqual([])
  })
})

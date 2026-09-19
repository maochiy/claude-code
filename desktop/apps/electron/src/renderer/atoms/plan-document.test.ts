import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { agentSidePanelOpenAtom, currentAgentSessionIdAtom } from './agent-atoms'
import { publishPlanDocumentAtom, selectedPlanDocumentAtomFamily } from './plan-document'

const first = { id: 'plan-1', content: '# 完整计划\n\n|责任|步骤|\n|---|---|\n|UI|实现|' }

describe('独立计划面板', () => {
  test('Given 当前会话生成计划 When 流式更新且用户关闭 Then 正文更新但不再弹开', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'a')
    store.set(publishPlanDocumentAtom, { sessionId: 'a', document: first, autoOpen: true })
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
    store.set(agentSidePanelOpenAtom, false)
    const revision = { ...first, content: `${first.content}\n\n最终验收` }
    store.set(publishPlanDocumentAtom, { sessionId: 'a', document: revision, autoOpen: true })
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    expect(store.get(selectedPlanDocumentAtomFamily('a'))).toEqual(revision)
    store.set(publishPlanDocumentAtom, { sessionId: 'a', document: { id: 'plan-2', content: '下一轮计划' }, autoOpen: true })
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
  })

  test('Given 后台会话生成计划 When 切换会话 Then 不抢面板且默认收起，点击旧计划打开精确版本', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'a')
    store.set(publishPlanDocumentAtom, { sessionId: 'b', document: first, autoOpen: true })
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    store.set(currentAgentSessionIdAtom, 'b')
    store.set(publishPlanDocumentAtom, { sessionId: 'b', document: first, autoOpen: true })
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    store.set(publishPlanDocumentAtom, { sessionId: 'b', document: { id: 'plan-2', content: '新版' }, autoOpen: true })
    store.set(publishPlanDocumentAtom, { sessionId: 'b', document: first, select: true })
    expect(store.get(selectedPlanDocumentAtomFamily('b'))).toEqual(first)
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
    store.set(currentAgentSessionIdAtom, 'a')
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    expect(store.get(selectedPlanDocumentAtomFamily('a'))).toBeUndefined()
  })

  test('Given 加载历史 When 恢复计划 Then 不自动打开，不覆盖实时或手动选择', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'a')
    store.set(publishPlanDocumentAtom, { sessionId: 'a', document: first })
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    const revision = { ...first, content: '更新后的完整正文' }
    store.set(publishPlanDocumentAtom, { sessionId: 'a', document: revision, autoOpen: true })
    store.set(publishPlanDocumentAtom, { sessionId: 'a', document: first })
    expect(store.get(selectedPlanDocumentAtomFamily('a'))).toEqual(revision)
  })

  test('Given 同一计划后续获得真实源路径 When 正文未变化 Then 更新可定位的源文件', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'a')
    store.set(publishPlanDocumentAtom, { sessionId: 'a', document: first, autoOpen: true })

    const sourcedPlan = { ...first, sourcePath: '/repo/.plans/feature.md' }
    store.set(publishPlanDocumentAtom, { sessionId: 'a', document: sourcedPlan, autoOpen: true })

    expect(store.get(selectedPlanDocumentAtomFamily('a'))).toEqual(sourcedPlan)
  })
})

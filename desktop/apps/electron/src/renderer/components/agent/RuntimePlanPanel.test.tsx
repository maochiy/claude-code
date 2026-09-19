import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { publishPlanDocumentAtom } from '@/atoms/plan-document'
import { RuntimePlanPanel, RuntimePlanToolbar } from './RuntimePlanPanel'
import { ProposedPlanCard } from './ProposedPlanCard'

describe('计划正文展示', () => {
  test('Given 多节长计划 When 打开右侧面板 Then 显示完整正文及表格而非截断摘要', () => {
    const store = createStore()
    const content = '# 完整实施计划\n\n| 职责 | 归属 |\n| --- | --- |\n| 实施 | 客户端 |\n\n' + Array.from({ length: 50 }, (_, index) => `步骤 ${index + 1}\n\n`).join('') + '最终验收标记'
    store.set(publishPlanDocumentAtom, { sessionId: 'a', document: { id: 'p', content } })
    const html = renderToStaticMarkup(<Provider store={store}><RuntimePlanPanel sessionId="a" /></Provider>)
    expect(html).toContain('data-plan-document')
    expect(html).toContain('完整实施计划')
    expect(html).toContain('最终验收标记')
    expect(html).toContain('<table')
    expect(html).not.toContain('max-h-[160px]')
  })
  test('Given 旧历史只有计划正文 When 渲染入口 Then 显示计划文档而不猜测为提出计划', () => {
    const html = renderToStaticMarkup(<Provider store={createStore()}><ProposedPlanCard documentId="p" sessionId="a" content="只在面板展示的全文" /></Provider>)
    expect(html).toContain('计划文档')
    expect(html).not.toContain('提出计划')
    expect(html).toContain('打开计划')
    expect(html).not.toContain('只在面板展示的全文')
  })

  test('Given 历史计划已批准 When 展开入口 Then 显示绿标阶段并可就地查看原文和打开完整面板', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <ProposedPlanCard documentId="p" sessionId="a" stage="approved" content="已批准计划正文" />
      </Provider>,
    )
    expect(html).toContain('data-plan-stage="approved"')
    expect(html).toContain('已批准计划')
    expect(html).toContain('查看完整计划')
    expect(html).toContain('emerald')
  })

  test('Given 计划处于不同历史阶段 When 渲染入口 Then 使用不同且准确的动作说明', () => {
    const renderStage = (stage: 'proposed' | 'changes_requested' | 'rejected'): string => renderToStaticMarkup(
      <Provider store={createStore()}>
        <ProposedPlanCard documentId={stage} stage={stage} content="计划正文" />
      </Provider>,
    )
    expect(renderStage('proposed')).toContain('提出计划')
    expect(renderStage('changes_requested')).toContain('已要求修改计划')
    expect(renderStage('rejected')).toContain('已拒绝计划')
  })

  test('Given 计划只有内存正文 When 渲染工具栏 Then 可复制和展开但不伪造源文件入口', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <RuntimePlanToolbar
          document={{ id: 'memory', content: '# 内存计划' }}
          expanded={false}
          onToggleExpanded={() => undefined}
          onOpenSource={() => undefined}
        />
      </Provider>,
    )

    expect(html).toContain('aria-label="复制完整计划"')
    expect(html).toContain('aria-label="展开面板"')
    expect(html).not.toContain('aria-label="打开计划源文件"')
  })

  test('Given Runtime 提供真实计划路径且面板已展开 When 渲染工具栏 Then 显示定位入口和还原动作', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <RuntimePlanToolbar
          document={{ id: 'file', content: '# 文件计划', sourcePath: '/repo/.plans/feature.md' }}
          expanded
          onToggleExpanded={() => undefined}
          onOpenSource={() => undefined}
        />
      </Provider>,
    )

    expect(html).toContain('aria-label="打开计划源文件"')
    expect(html).toContain('title="/repo/.plans/feature.md"')
    expect(html).toContain('aria-label="还原面板大小"')
    expect(html).toContain('aria-pressed="true"')
  })
})

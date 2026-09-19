import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import {
  buildContextCategoryRows,
  ContextBreakdownFeedback,
  ContextUsageBadge,
} from './ContextUsageBadge'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'

function renderBadge(props: Record<string, unknown>): string {
  const store = createStore()
  if (props.language === 'en') {
    store.set(settingsPreferencesAtom, (preferences) => ({ ...preferences, interfaceLanguage: 'en' }))
  }
  return renderToStaticMarkup(
    <Provider store={store}>
    <ContextUsageBadge
      inputTokens={props.inputTokens as number | undefined}
      outputTokens={props.outputTokens as number | undefined}
      cacheReadTokens={props.cacheReadTokens as number | undefined}
      contextWindow={props.contextWindow as number | undefined}
      isEstimated={props.isEstimated as boolean}
      autoCompactEnabled={props.autoCompactEnabled as boolean | undefined}
      autoCompactThreshold={props.autoCompactThreshold as number | undefined}
      effectiveContextWindow={props.effectiveContextWindow as number | undefined}
      isCompacting={props.isCompacting as boolean}
      isProcessing={props.isProcessing as boolean}
      onCompact={() => {}}
      sessionId="session-1"
      channelId={props.channelId as string | null | undefined}
      channelUpdatedAt={props.channelUpdatedAt as number | undefined}
      variant={props.variant as 'icon' | 'text' | undefined}
      contextBreakdown={props.contextBreakdown as never}
    />
    </Provider>,
  )
}

describe('ContextUsageBadge 上下文执行情况入口', () => {
  test('Given 用户明确刷新失败 When 渲染上下文状态 Then 在面板中显示错误', () => {
    const html = renderToStaticMarkup(
      <ContextBreakdownFeedback
        loading={false}
        error="CLI 启动失败"
        loadingLabel="正在读取上下文详情"
      />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('CLI 启动失败')
  })

  test('Given 用户正在明确刷新 When 渲染上下文状态 Then 显示加载反馈', () => {
    const html = renderToStaticMarkup(
      <ContextBreakdownFeedback
        loading
        loadingLabel="正在读取上下文详情"
      />,
    )
    expect(html).toContain('role="status"')
    expect(html).toContain('正在读取上下文详情')
  })

  test('Given 只有上下文窗口没有 token usage When 渲染 Then 仍显示入口按钮', () => {
    const html = renderBadge({ contextWindow: 200_000, isEstimated: false, isCompacting: false, isProcessing: false })
    expect(html).toContain('<button')
    expect(html).toContain('<svg')
  })

  test('Given 无任何上下文元数据 When 渲染 Then 不显示入口', () => {
    const html = renderBadge({ isEstimated: false, isCompacting: false, isProcessing: false })
    expect(html).toBe('')
  })

  test('Given 只有压缩阈值没有 token usage When 渲染 Then 仍显示入口按钮', () => {
    const html = renderBadge({
      autoCompactEnabled: true,
      autoCompactThreshold: 150_000,
      isEstimated: false,
      isCompacting: false,
      isProcessing: false,
    })
    expect(html).toContain('<button')
  })

  test('Given 有 token usage 与上下文窗口 When 渲染 Then 显示入口与占用比例', () => {
    const html = renderBadge({
      inputTokens: 24_000,
      contextWindow: 200_000,
      isEstimated: false,
      isCompacting: false,
      isProcessing: false,
    })
    expect(html).toContain('<button')
    expect(html).toContain('<svg')
  })

  test('Given 压缩中 When 渲染 Then 显示 spinner 且禁用', () => {
    const html = renderBadge({
      inputTokens: 24_000,
      isEstimated: false,
      isCompacting: true,
      isProcessing: false,
    })
    expect(html).toContain('animate-spin')
    expect(html).toContain('disabled')
  })

  test('Given 只有缓存读取数据 When 渲染 Then 不显示缓存读取明细行（弹层 hover 才出现）', () => {
    const html = renderBadge({
      inputTokens: 30_000,
      contextWindow: 200_000,
      cacheReadTokens: 12_000,
      isEstimated: false,
      isCompacting: false,
      isProcessing: false,
    })
    expect(html).not.toContain('缓存读取')
  })

  test('Given Runtime 只返回分类而没有容量 When 渲染 Then 显示入口但不伪造百分比容量', () => {
    const breakdown = {
      categories: [{ name: 'Messages', tokens: 1_200, color: 'blue' }],
      totalTokens: 1_200,
    }
    const html = renderBadge({
      contextBreakdown: breakdown,
      variant: 'text',
      isEstimated: false,
      isCompacting: false,
      isProcessing: false,
    })
    expect(html).toContain('上下文 1.2k')
    expect(html).not.toContain('(0%)')
    expect(buildContextCategoryRows(breakdown)).toEqual([{
      name: 'Messages',
      tokens: 1_200,
      color: '#7c8fd3',
    }])
  })

  test('Given Runtime 返回真实容量和分类 When 建立分类行 Then 百分比按真实容量计算', () => {
    expect(buildContextCategoryRows({
      categories: [
        { name: 'System prompt', tokens: 20_000, color: '#123456' },
        { name: 'Free space', tokens: 80_000, color: '#eeeeee' },
      ],
      totalTokens: 20_000,
      maxTokens: 100_000,
    })).toEqual([
      { name: 'System prompt', tokens: 20_000, color: '#123456', percentage: 20 },
      { name: 'Free space', tokens: 80_000, color: '#eeeeee', percentage: 80 },
    ])
  })
})

describe('ContextUsageBadge 文字胶囊入口（variant=text，对齐参考截图 15/16）', () => {
  test('Given 有 token usage 与窗口 When 渲染 Then 显示「上下文」胶囊与展开指示', () => {
    const html = renderBadge({
      inputTokens: 90_100,
      contextWindow: 200_000,
      variant: 'text',
      isEstimated: false,
      isCompacting: false,
      isProcessing: false,
    })
    expect(html).toContain('上下文 90.1k/200.0k (45%)')
    expect(html).not.toContain('<circle')
    expect(html).not.toContain('animate-spin')
  })

  test('Given 只有窗口没有 usage When 渲染 Then 仍显示文字胶囊（0 占位）', () => {
    const html = renderBadge({
      contextWindow: 200_000,
      variant: 'text',
      isEstimated: false,
      isCompacting: false,
      isProcessing: false,
    })
    expect(html).toContain('上下文 0/200.0k (0%)')
  })

  test('Given 英文界面 When 渲染相同文字胶囊 Then 上下文标签即时使用英文', () => {
    const html = renderBadge({
      inputTokens: 90_100,
      contextWindow: 200_000,
      variant: 'text',
      language: 'en',
      isEstimated: false,
      isCompacting: false,
      isProcessing: false,
    })
    expect(html).toContain('Context 90.1k/200.0k (45%)')
    expect(html).toContain('Context usage and compaction settings')
  })

  test('Given 占用达到压缩阈值 80% When 渲染 Then 胶囊进入琥珀警告态', () => {
    const html = renderBadge({
      inputTokens: 120_000,
      contextWindow: 200_000,
      autoCompactEnabled: true,
      autoCompactThreshold: 150_000,
      variant: 'text',
      isEstimated: false,
      isCompacting: false,
      isProcessing: false,
    })
    expect(html).toContain('amber')
  })

  test('Given 压缩中 When 渲染 Then 显示 spinner 而不是文字胶囊', () => {
    const html = renderBadge({
      inputTokens: 90_100,
      variant: 'text',
      isEstimated: false,
      isCompacting: true,
      isProcessing: false,
    })
    expect(html).toContain('animate-spin')
    expect(html).not.toContain('上下文')
  })
})

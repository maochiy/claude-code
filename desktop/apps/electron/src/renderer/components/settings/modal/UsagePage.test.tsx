import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { UsageChart } from './UsagePage'

describe('UsageChart', () => {
  test('Given 每日分类用量 When 渲染图表 Then 每天都是可聚焦按钮并提供完整无障碍明细', () => {
    const html = renderToStaticMarkup(
      <UsageChart
        language="zh"
        series={[
          { day: '2026-09-16', coworkTokens: 0, codeTokens: 184_400_000, autoTokens: 0, totalTokens: 184_400_000, userMessages: 1, turns: 1, modelCalls: 2 },
          { day: '2026-09-17', coworkTokens: 25, codeTokens: 70, autoTokens: 5, totalTokens: 100, userMessages: 1, turns: 1, modelCalls: 1 },
        ]}
      />,
    )

    expect(html.match(/type="button"/g)).toHaveLength(2)
    expect(html).toContain('2026年9月16日，Cowork 0 tokens，Code 184,400,000 tokens，Auto 0 tokens')
    expect(html).toContain('2026年9月17日，Cowork 25 tokens，Code 70 tokens，Auto 5 tokens')
    expect(html).toContain('data-usage-chart="true"')
  })
})

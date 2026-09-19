import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'
import { AgentThinkingEffortControl } from './AgentThinkingEffortControl'

describe('AgentThinkingEffortControl 思考等级卡片', () => {
  test('Given 英文界面 When 渲染思考等级 Then 标题、徽章和辅助标签均使用英文', () => {
    const store = createStore()
    store.set(settingsPreferencesAtom, (previous) => ({ ...previous, interfaceLanguage: 'en' }))
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <AgentThinkingEffortControl
          capability={{ levels: ['low', 'medium', 'high'], defaultLevel: 'medium' }}
          value="high"
          onValueChange={() => {}}
        />
      </Provider>,
    )
    expect(html).toContain('>Effort</span>')
    expect(html).toContain('>Faster</span>')
    expect(html).toContain('>Smarter</span>')
    expect(html).toContain('aria-valuetext="High"')
    expect(html).not.toContain('思考等级')
  })

  test('Given 模型支持思考等级 When 渲染面板 Then 展示中文标题、速度提示与分段滑轨', () => {
    const html = renderToStaticMarkup(
      <AgentThinkingEffortControl
        capability={{ levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'medium' }}
        value="high"
        onValueChange={() => {}}
      />,
    )

    expect(html).toContain('>思考强度</span>')
    expect(html).toContain('>更快</span>')
    expect(html).toContain('>更聪明</span>')
    // Runtime 目录 5 档中最高两档合并后为 4 段
    expect(html.match(/aria-pressed/g)).toHaveLength(4)
    expect(html).toContain('aria-valuenow="3"')
    expect(html).toContain('aria-valuetext="高"')
    expect(html).not.toContain('该模型未启用思考等级')
  })

  test('Given 当前档位为合并后的最高档 When 渲染面板 Then 末段选中且徽章为极高', () => {
    const html = renderToStaticMarkup(
      <AgentThinkingEffortControl
        capability={{ levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'medium' }}
        value="xhigh"
        onValueChange={() => {}}
      />,
    )

    expect(html).toContain('aria-valuenow="4"')
    expect(html).toContain('aria-valuetext="极高"')
  })

  test('Given 模型关闭思考等级 When 渲染面板 Then 提示未启用且不渲染滑杆', () => {
    const html = renderToStaticMarkup(
      <AgentThinkingEffortControl capability={null} onValueChange={() => {}} />,
    )

    expect(html).toContain('该模型未启用思考等级')
    expect(html).not.toContain('role="slider"')
  })
})

import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ModelOption } from '@proma/shared'
import { AgentModelEffortControl } from './AgentModelEffortControl'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'

const model: ModelOption = {
  channelId: 'test', channelName: '测试渠道', modelId: 'model-1', modelName: '模型 A', provider: 'custom',
}

describe('输入框模型与思考等级入口', () => {
  test('Given 已选择模型与等级 When 渲染 Then 模型名与档位徽章是两个并列触发器', () => {
    const html = renderToStaticMarkup(<Provider><AgentModelEffortControl
      models={[model]}
      selectedModel={model}
      loading={false}
      modelSwitchDisabled={false}
      capability={{ levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'medium' }}
      effortLevel="xhigh"
      onModelSelect={() => {}}
      onEffortChange={() => {}}
    /></Provider>)
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).toContain('当前模型：模型 A')
    expect(html).toContain('思考等级：极高')
    expect(html).toContain('极高')
  })

  test('Given 英文界面 When 渲染相同模型与等级入口 Then 标签与等级使用英文', () => {
    const store = createStore()
    store.set(settingsPreferencesAtom, (preferences) => ({ ...preferences, interfaceLanguage: 'en' }))
    const html = renderToStaticMarkup(<Provider store={store}><AgentModelEffortControl
      models={[model]}
      selectedModel={model}
      loading={false}
      modelSwitchDisabled={false}
      capability={{ levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'medium' }}
      effortLevel="xhigh"
      onModelSelect={() => {}}
      onEffortChange={() => {}}
    /></Provider>)

    expect(html).toContain('Current model: 模型 A')
    expect(html).toContain('Thinking level: Extra')
    expect(html).toContain('Extra')
  })

  test('Given 目录未加载或模型不支持思考 When 渲染入口 Then 只保留模型触发器而不显示虚假等级', () => {
    const html = renderToStaticMarkup(<Provider><AgentModelEffortControl
      models={[]}
      selectedModel={model}
      loading={true}
      modelSwitchDisabled={false}
      capability={null}
      onModelSelect={() => {}}
      onEffortChange={() => {}}
    /></Provider>)
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('当前模型：model-1')
    expect(html).not.toContain('Extra')
  })

  test('Given 参考截图工具行 When 渲染模型触发器 Then 模型名不带 v 箭头（纯文字 + 展开弹层）', () => {
    const html = renderToStaticMarkup(<Provider><AgentModelEffortControl
      models={[model]}
      selectedModel={model}
      loading={false}
      modelSwitchDisabled={false}
      capability={{ levels: ['medium'], defaultLevel: 'medium' }}
      effortLevel="medium"
      onModelSelect={() => {}}
      onEffortChange={() => {}}
    /></Provider>)
    expect(html).not.toContain('polyline')
  })
})

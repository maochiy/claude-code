import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'
import { NewApiLoginView } from './NewApiLoginView'

describe('OpenSwitch 可选登录入口', () => {
  test('Given 从设置打开登录页 When 提供退出回调 Then 显示可关闭入口与可选说明', () => {
    const html = renderToStaticMarkup(
      <Provider>
        <NewApiLoginView onLoginSuccess={async () => {}} onCancel={() => {}} />
      </Provider>,
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('暂不登录')
    expect(html).toContain('不登录也可以使用本地 CLI')
  })

  test('Given 英文界面 When 打开可选登录入口 Then 登录与退出文案使用英文', () => {
    const store = createStore()
    store.set(settingsPreferencesAtom, (preferences) => ({ ...preferences, interfaceLanguage: 'en' }))
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <NewApiLoginView onLoginSuccess={async () => {}} onCancel={() => {}} />
      </Provider>,
    )

    expect(html).toContain('Sign in and connect')
    expect(html).toContain('Not now')
    expect(html).toContain('local CLI')
  })
})

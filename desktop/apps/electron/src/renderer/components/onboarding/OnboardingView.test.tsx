import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'
import {
  TutorialBannerContent,
} from '@/components/tutorial/TutorialBanner'
import { OnboardingView } from './OnboardingView'

function renderLocalized(language: 'zh' | 'en'): string {
  const store = createStore()
  store.set(settingsPreferencesAtom, (preferences) => ({
    ...preferences,
    interfaceLanguage: language,
  }))
  return renderToStaticMarkup(
    <Provider store={store}>
      <OnboardingView onComplete={() => undefined} />
      <TutorialBannerContent
        visible
        onLearnNow={() => undefined}
        onLater={() => undefined}
      />
    </Provider>,
  )
}

describe('首次引导与教程横幅国际化', () => {
  test('Given 英文界面 When 显示首次引导和教程横幅 Then 全部主要操作使用英文', () => {
    const html = renderLocalized('en')

    expect(html).toContain('Welcome to Xcodes')
    expect(html).toContain('Explore the tutorial')
    expect(html).toContain('Migrate from another device')
    expect(html).toContain('Import another user’s setup')
    expect(html).toContain('Get started')
    expect(html).toContain('Xcodes Tutorial')
    expect(html).toContain('Start learning')
    expect(html).toContain('Maybe later')
    expect(html).toContain('aria-label="Dismiss tutorial suggestion"')
    expect(html).not.toContain('欢迎使用 Xcodes')
    expect(html).not.toContain('立即学习')
  })

  test('Given 中文界面 When 显示首次引导和教程横幅 Then 保留完整中文引导', () => {
    const html = renderLocalized('zh')

    expect(html).toContain('欢迎使用 Xcodes')
    expect(html).toContain('查看使用教程')
    expect(html).toContain('从其他设备迁移')
    expect(html).toContain('导入其他用户的配置')
    expect(html).toContain('开始使用')
    expect(html).toContain('Xcodes 使用教程')
    expect(html).toContain('立即学习')
    expect(html).toContain('稍后再学')
    expect(html).toContain('aria-label="关闭教程推荐"')
  })
})

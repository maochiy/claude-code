import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { normalizeSettingsTab } from '@/atoms/settings-tab'
import type { SettingsTab } from '@/atoms/settings-tab'
import { themeModeAtom, themeStyleAtom } from '@/atoms/theme'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'
import { SettingsModalNav } from './SettingsModalNav'
import { GeneralPage } from './GeneralPage'
import { ClaudeCodePage } from './ClaudeCodePage'

// AboutSettings 在模块顶层读取 Vite define 注入的版本号，测试环境补齐后再动态加载模态框
Reflect.set(globalThis, '__APP_VERSION__', '0.0.0-test')
const { SettingsModal, renderSettingsPage } = await import('./SettingsModal')

function renderNav(activeTab: SettingsTab = 'settings-general'): string {
  const store = createStore()
  store.set(settingsPreferencesAtom, (preferences) => ({ ...preferences, interfaceLanguage: 'en' }))
  return renderToStaticMarkup(
    <Provider store={store}>
      <SettingsModalNav activeTab={activeTab} onNavigate={() => undefined} />
    </Provider>,
  )
}

function renderWithStore(node: React.ReactElement, themeMode: 'special' | 'system', themeStyle: string): string {
  const store = createStore()
  store.set(themeModeAtom, themeMode)
  store.set(themeStyleAtom, themeStyle as never)
  store.set(settingsPreferencesAtom, (preferences) => ({ ...preferences, interfaceLanguage: 'en' }))
  return renderToStaticMarkup(
    <Provider store={store}>
      {node}
    </Provider>,
  )
}

describe('设置模态框左侧导航（对齐参考桌面端）', () => {
  test('Given 同一导航组件 When 切换中英文 Then 可见分组随语言状态更新', () => {
    const english = renderNav()
    const store = createStore()
    store.set(settingsPreferencesAtom, (preferences) => ({ ...preferences, interfaceLanguage: 'zh' }))
    const chinese = renderToStaticMarkup(
      <Provider store={store}><SettingsModalNav activeTab="settings-general" onNavigate={() => undefined} /></Provider>,
    )

    expect(english).toContain('>Settings</div>')
    expect(chinese).toContain('>设置</div>')
    expect(chinese).toContain('placeholder="搜索"')
    expect(chinese).toContain('>模型配置</span>')
    expect(english).toContain('>Model configuration</span>')
  })

  test('Given 打开设置模态框 When 渲染导航 Then 有搜索框与 Settings/Desktop app/Customize 三分组', () => {
    const html = renderNav()

    expect(html).toContain('placeholder="Search"')
    expect(html).toContain('>Settings</div>')
    expect(html).toContain('data-settings-nav-item="settings-general"')
    expect(html).not.toContain('data-settings-nav-item="privacy"')
    expect(html).toContain('data-settings-nav-item="usage"')
    expect(html).toContain('data-settings-nav-item="claude-code"')
    expect(html).not.toContain('data-settings-nav-item="cowork"')
    expect(html).not.toContain('data-settings-nav-item="import-export"')
    expect(html).toContain('>Desktop app</div>')
    expect(html).toContain('data-settings-nav-item="desktop-general"')
    expect(html).toContain('data-settings-nav-item="desktop-developer"')
    expect(html).toContain('>Customize</div>')
    expect(html).toContain('data-settings-nav-item="skills"')
    expect(html).toContain('data-settings-nav-item="connectors"')
    expect(html).not.toContain('data-settings-nav-item="plugins"')
    // 所有条目带 16px 线性图标（参考图原样）
    const generalItem = html.slice(html.indexOf('data-settings-nav-item="settings-general"'))
    expect(generalItem.slice(0, generalItem.indexOf('</button>'))).toContain('<svg')
  })

  test('Given 当前页为 Connectors When 渲染导航 Then 仅 Connectors 高亮为当前页', () => {
    const html = renderNav('connectors')

    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toContain('data-settings-nav-item="connectors"')
  })
})

describe('General 页（Profile / Instructions / Preferences / Notifications）', () => {
  test('Given General 页 When 渲染 Then 展示 Profile、指令输入框、外观三选一与通知开关', () => {
    const html = renderWithStore(<GeneralPage />, 'system', 'default')

    expect(html).toContain('>Profile</h1>')
    expect(html).toContain('Avatar')
    expect(html).toContain('What best describes your work?')
    expect(html).toContain('Instructions')
    expect(html).toContain('e.g. keep explanations brief and to the point')
    expect(html).toContain('Preferences')
    expect(html).toContain('aria-label="Appearance"')
    expect(html).toContain('Chat font')
    expect(html).toContain('Motion')
    expect(html).toContain('Notifications')
    expect(html).toContain('Response completions')
  })
})

describe('Claude Code 页（主题与本地会话设置）', () => {
  test('Given Claude Code 页 When 渲染 Then 展示主题预览卡、Code font 与 Local sessions', () => {
    const html = renderWithStore(<ClaudeCodePage />, 'special', 'cursor-dark')

    expect(html).toContain('>Claude Code</h1>')
    expect(html).toContain('Code appearance')
    expect(html).toContain('data-theme-preview-code')
    expect(html).toContain('Code font')
    expect(html).toContain('data-code-font-input')
    expect(html).toContain('Interface font')
    expect(html).toContain('Transcript text size')
    expect(html).toContain('Transcript width')
    expect(html).toContain('Local sessions')
    expect(html).toContain('Allow bypass permissions mode')
    expect(html).toContain('Keep computer awake while working')
    expect(html).toContain('Archive inactive sessions')
    expect(html).toContain('Worktree location')
    expect(html).toContain('Output style')
    expect(html).toContain('Local sandbox')
  })

  test('Given 深色主题 When 渲染 Claude Code 页 Then 仅 Dark 预览卡处于选中态', () => {
    const html = renderWithStore(<ClaudeCodePage />, 'special', 'cursor-dark')

    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    const pressedIndex = html.indexOf('aria-pressed="true"')
    const darkIndex = html.indexOf('>Dark</div>')
    expect(pressedIndex).toBeGreaterThan(-1)
    expect(pressedIndex).toBeLessThan(darkIndex)
  })
})

describe('设置页路由与旧深链兼容', () => {
  test('Given 新导航页 When 渲染对应页面 Then 各页渲染各自内容', () => {
    const renderEnglishPage = (tab: SettingsTab): string => {
      const store = createStore()
      store.set(settingsPreferencesAtom, (preferences) => ({ ...preferences, interfaceLanguage: 'en' }))
      return renderToStaticMarkup(<Provider store={store}>{renderSettingsPage(tab)}</Provider>)
    }
    expect(renderEnglishPage('settings-general')).toContain('>Profile</h1>')
    expect(renderEnglishPage('privacy')).toContain('>Privacy</h1>')
    expect(renderEnglishPage('usage')).toContain('Tokens per day')
    expect(renderEnglishPage('claude-code')).toContain('Local sessions')
    expect(renderEnglishPage('cowork')).toContain('>Cowork</h1>')
    expect(renderEnglishPage('import-export')).toContain('>Import &amp; export</h1>')
    expect(renderEnglishPage('skills')).toContain('>Skills</h1>')
  })

  test('Given 旧深链 ID When 归一化 Then 映射到新导航页且未知 ID 原样保留', () => {
    expect(normalizeSettingsTab('appearance')).toBe('settings-general')
    expect(normalizeSettingsTab('channels')).toBe('connectors')
    expect(normalizeSettingsTab('tools')).toBe('plugins')
    expect(normalizeSettingsTab('about')).toBe('desktop-developer')
    expect(normalizeSettingsTab('profile')).toBe('desktop-general')
    expect(normalizeSettingsTab('general')).toBe('desktop-general')
    expect(normalizeSettingsTab('proxy')).toBe('proxy')
    expect(normalizeSettingsTab('settings-general')).toBe('settings-general')
  })

  test('Given 未映射的旧深链 When 渲染页面 Then 保留原有设置页功能', () => {
    // ProxySettings 静态渲染处于加载态，能渲染即代表旧页面组件被保留
    expect(renderToStaticMarkup(renderSettingsPage('proxy'))).toContain('加载中')
    expect(renderToStaticMarkup(renderSettingsPage('storage'))).not.toBe('')
  })

  test('Given 模态框未打开 When 渲染 SettingsModal Then 不产生任何 DOM 且不报错', () => {
    const html = renderToStaticMarkup(
      <Provider store={createStore()}>
        <SettingsModal />
      </Provider>,
    )
    expect(html).toBe('')
  })
})

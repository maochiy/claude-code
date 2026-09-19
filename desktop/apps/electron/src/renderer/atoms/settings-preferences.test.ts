import { afterAll, describe, expect, test } from 'bun:test'
import type { AppSettings } from '../../types'
import {
  DEFAULT_SETTINGS_PREFERENCES,
  applyChatFontToDOM,
  applyMotionPreferenceToDOM,
  applyTranscriptWidthToDOM,
  getTranscriptWidthCssValue,
  isReducedMotionActive,
  preferencesFromSettings,
  updateSettingsPreference,
  updateInterfaceLanguage,
  type SettingsPreferences,
} from './settings-preferences'

const originalDocument = globalThis.document
const originalWindow = globalThis.window

afterAll(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
})

function installEnvironment(updateSettings: (updates: Partial<AppSettings>) => Promise<AppSettings>): Map<string, string> {
  const styles = new Map<string, string>()
  const classes = new Set<string>()
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: {
        lang: 'zh-CN',
        style: { setProperty: (key: string, value: string) => { styles.set(key, value) } },
        classList: {
          toggle: (name: string, force?: boolean) => {
            if (force === true) classes.add(name)
            else if (force === false) classes.delete(name)
            else if (classes.has(name)) classes.delete(name)
            else classes.add(name)
            return classes.has(name)
          },
          contains: (name: string) => classes.has(name),
        },
      },
    } as unknown as Document,
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: { updateSettings },
      matchMedia: () => ({ matches: false }),
    } as unknown as Window & typeof globalThis,
  })
  return styles
}

function createState(): {
  get: () => SettingsPreferences
  set: (update: (prev: SettingsPreferences) => SettingsPreferences) => void
} {
  let state = { ...DEFAULT_SETTINGS_PREFERENCES }
  return {
    get: () => state,
    set: (update) => { state = update(state) },
  }
}

describe('界面语言持久化', () => {
  test('旧版或非法语言值回落为中文', () => {
    const preferences = preferencesFromSettings({
      themeMode: 'system',
      interfaceLanguage: 'fr',
    } as unknown as AppSettings)

    expect(preferences.interfaceLanguage).toBe('zh')
  })

  test('保存成功时同步 atom 与 document.lang', async () => {
    installEnvironment(async (updates) => ({ themeMode: 'system', ...updates } as AppSettings))
    const state = createState()

    const saved = await updateInterfaceLanguage('en', 'zh', state.set)

    expect(saved).toBe(true)
    expect(state.get().interfaceLanguage).toBe('en')
    expect(document.documentElement.lang).toBe('en-US')
  })

  test('保存失败时回滚 atom 与 document.lang', async () => {
    installEnvironment(async () => { throw new Error('disk full') })
    const state = createState()

    const saved = await updateInterfaceLanguage('en', 'zh', state.set)

    expect(saved).toBe(false)
    expect(state.get().interfaceLanguage).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
  })
})

describe('对话宽度偏好', () => {
  test('Given 三档宽度 When 映射样式 Then 产生稳定且递增的列宽', () => {
    expect(getTranscriptWidthCssValue('narrow')).toBe('768px')
    expect(getTranscriptWidthCssValue('medium')).toBe('960px')
    expect(getTranscriptWidthCssValue('wide')).toBe('1152px')
  })

  test('Given 页面已加载 When 切换为宽布局 Then 立即更新共享 CSS 变量并持久化', async () => {
    const saved: Partial<AppSettings>[] = []
    const styles = installEnvironment(async (updates) => {
      saved.push(updates)
      return { themeMode: 'system', ...updates } as AppSettings
    })
    const state = createState()

    await updateSettingsPreference('transcriptWidth', 'wide', state.set)

    expect(state.get().transcriptWidth).toBe('wide')
    expect(styles.get('--transcript-max-width')).toBe('1152px')
    expect(saved).toEqual([{ transcriptWidth: 'wide' }])
  })

  test('Given 外部初始化宽度 When 应用到 DOM Then 消息和输入区读取相同变量', () => {
    const styles = installEnvironment(async (updates) => ({ themeMode: 'system', ...updates } as AppSettings))
    applyTranscriptWidthToDOM('medium')
    expect(styles.get('--transcript-max-width')).toBe('960px')
  })
})

describe('设置偏好真实消费与失败回滚', () => {
  test('Given 选择系统对话字体 When 应用偏好 Then 消息正文变量切换为系统字体', () => {
    const styles = installEnvironment(async (updates) => ({ themeMode: 'system', ...updates } as AppSettings))

    applyChatFontToDOM('system')

    expect(styles.get('--chat-font-family')).toContain('system-ui')
  })

  test('Given 用户选择减少动效 When 应用偏好 Then 根节点启用统一动效类', () => {
    installEnvironment(async (updates) => ({ themeMode: 'system', ...updates } as AppSettings))

    applyMotionPreferenceToDOM('reduced')

    expect(document.documentElement.classList.contains('reduce-motion')).toBe(true)
    expect(isReducedMotionActive()).toBe(true)
    applyMotionPreferenceToDOM('system')
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(false)
    expect(isReducedMotionActive()).toBe(false)
  })

  test('Given 设置文件写入失败 When 更新对话宽度 Then atom 与 DOM 都恢复原值', async () => {
    const styles = installEnvironment(async () => { throw new Error('disk full') })
    const state = createState()
    applyTranscriptWidthToDOM(state.get().transcriptWidth)

    const saved = await updateSettingsPreference('transcriptWidth', 'wide', state.set)

    expect(saved).toBe(false)
    expect(state.get().transcriptWidth).toBe('narrow')
    expect(styles.get('--transcript-max-width')).toBe('768px')
  })
})

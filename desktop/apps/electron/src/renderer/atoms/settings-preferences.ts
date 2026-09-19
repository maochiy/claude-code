/**
 * 设置页偏好原子（对齐参考桌面端设置项）
 *
 * 每个偏好一个 atom；统一从 ~/.proma/settings.json 初始化与持久化。
 * 仅 UI 偏好放这里；有独立 DOM/运行时副作用的（主题、代码字体等）仍在各自文件中。
 */

import { atom } from 'jotai'
import type { AppSettings } from '../../types'

/** 与设置页相关的偏好键集合 */
export interface SettingsPreferences {
  interfaceLanguage: 'zh' | 'en'
  workType: string
  customInstructions: string
  chatFont: string
  motionPreference: 'system' | 'reduced'
  transcriptWidth: 'narrow' | 'medium' | 'wide'
  responseCompletionNotification: boolean
  allowBypassPermissionsMode: boolean
  dynamicWorkflowsEnabled: boolean
  drawAttentionOnNotifications: boolean
  keepAwakeWhileWorking: boolean
  keepAwakeOnBattery: boolean
  archiveAfterDays: number
  worktreeLocation: 'inside-project' | 'global'
  outputStyle: 'default' | 'concise' | 'detailed'
  localSandboxEnabled: boolean
  strictSandboxMode: boolean
}

export const DEFAULT_SETTINGS_PREFERENCES: SettingsPreferences = {
  interfaceLanguage: 'zh',
  workType: '',
  customInstructions: '',
  chatFont: '',
  motionPreference: 'system',
  transcriptWidth: 'narrow',
  responseCompletionNotification: true,
  allowBypassPermissionsMode: true,
  dynamicWorkflowsEnabled: false,
  drawAttentionOnNotifications: false,
  keepAwakeWhileWorking: false,
  keepAwakeOnBattery: false,
  archiveAfterDays: 7,
  worktreeLocation: 'inside-project',
  outputStyle: 'default',
  localSandboxEnabled: false,
  strictSandboxMode: false,
}

const TRANSCRIPT_WIDTH_PX: Record<SettingsPreferences['transcriptWidth'], number> = {
  narrow: 768,
  medium: 960,
  wide: 1152,
}

const DEFAULT_CHAT_FONT_STACK =
  '"Anthropic Serif", ui-serif, Georgia, Cambria, "Times New Roman", Times, serif'
const SYSTEM_CHAT_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
export const REDUCED_MOTION_CLASS = 'reduce-motion'

export function getTranscriptWidthCssValue(width: SettingsPreferences['transcriptWidth']): string {
  return `${TRANSCRIPT_WIDTH_PX[width]}px`
}

/** 从 AppSettings 提取偏好子集（缺省回落默认值） */
export function preferencesFromSettings(settings: AppSettings): SettingsPreferences {
  return {
    // 配置文件可能来自旧版本或被手工编辑；运行时仅接受受支持的语言值。
    interfaceLanguage: settings.interfaceLanguage === 'en' ? 'en' : 'zh',
    workType: settings.workType ?? '',
    customInstructions: settings.customInstructions ?? '',
    chatFont: settings.chatFont ?? '',
    motionPreference: settings.motionPreference ?? 'system',
    transcriptWidth: settings.transcriptWidth ?? 'narrow',
    responseCompletionNotification: settings.responseCompletionNotification ?? true,
    allowBypassPermissionsMode: settings.allowBypassPermissionsMode ?? true,
    dynamicWorkflowsEnabled: settings.dynamicWorkflowsEnabled ?? false,
    drawAttentionOnNotifications: settings.drawAttentionOnNotifications ?? false,
    keepAwakeWhileWorking: settings.keepAwakeWhileWorking ?? false,
    keepAwakeOnBattery: settings.keepAwakeOnBattery ?? false,
    archiveAfterDays: settings.archiveAfterDays ?? 7,
    worktreeLocation: settings.worktreeLocation ?? 'inside-project',
    outputStyle: settings.outputStyle ?? 'default',
    localSandboxEnabled: settings.localSandboxEnabled ?? false,
    strictSandboxMode: settings.strictSandboxMode ?? false,
  }
}

/** 设置页偏好集合（单 atom，整组读写） */
export const settingsPreferencesAtom = atom<SettingsPreferences>(DEFAULT_SETTINGS_PREFERENCES)

/** 同步文档语言，供辅助技术和原生文本行为使用。 */
export function applyInterfaceLanguageToDOM(language: SettingsPreferences['interfaceLanguage']): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en-US'
}

/** 消息正文和输入区共享同一宽度变量，切换设置后无需重载页面。 */
export function applyTranscriptWidthToDOM(width: SettingsPreferences['transcriptWidth']): void {
  if (typeof document === 'undefined') return
  document.documentElement.style?.setProperty('--transcript-max-width', getTranscriptWidthCssValue(width))
}

/** 对话正文使用独立字体变量，不改变菜单、代码块与终端字体。 */
export function applyChatFontToDOM(font: SettingsPreferences['chatFont']): void {
  if (typeof document === 'undefined') return
  document.documentElement.style?.setProperty(
    '--chat-font-family',
    font === 'system' ? SYSTEM_CHAT_FONT_STACK : DEFAULT_CHAT_FONT_STACK,
  )
}

/** reduced 强制减弱动效；system 不加覆盖类，继续遵从系统媒体查询。 */
export function applyMotionPreferenceToDOM(preference: SettingsPreferences['motionPreference']): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList?.toggle(REDUCED_MOTION_CLASS, preference === 'reduced')
}

/** JS 驱动的滚动动画与 CSS 动效使用同一偏好语义。 */
export function isReducedMotionActive(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.classList?.contains(REDUCED_MOTION_CLASS)) {
    return true
  }
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function applyPreferenceSideEffect<K extends keyof SettingsPreferences>(
  key: K,
  value: SettingsPreferences[K],
): void {
  if (key === 'interfaceLanguage') {
    applyInterfaceLanguageToDOM(value as SettingsPreferences['interfaceLanguage'])
  } else if (key === 'transcriptWidth') {
    applyTranscriptWidthToDOM(value as SettingsPreferences['transcriptWidth'])
  } else if (key === 'chatFont') {
    applyChatFontToDOM(value as SettingsPreferences['chatFont'])
  } else if (key === 'motionPreference') {
    applyMotionPreferenceToDOM(value as SettingsPreferences['motionPreference'])
  }
}

/** 从主进程加载偏好 */
export async function initializeSettingsPreferences(
  set: (prefs: SettingsPreferences) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    const preferences = preferencesFromSettings(settings)
    set(preferences)
    applyInterfaceLanguageToDOM(preferences.interfaceLanguage)
    applyTranscriptWidthToDOM(preferences.transcriptWidth)
    applyChatFontToDOM(preferences.chatFont)
    applyMotionPreferenceToDOM(preferences.motionPreference)
  } catch (error) {
    console.error('[设置偏好] 初始化失败:', error)
  }
}

/** 更新单个偏好并持久化 */
export async function updateSettingsPreference<K extends keyof SettingsPreferences>(
  key: K,
  value: SettingsPreferences[K],
  set: (fn: (prev: SettingsPreferences) => SettingsPreferences) => void,
): Promise<boolean> {
  let previousValue = value
  set((prev) => {
    previousValue = prev[key]
    return { ...prev, [key]: value }
  })
  applyPreferenceSideEffect(key, value)
  try {
    await window.electronAPI.updateSettings({ [key]: value } as Partial<AppSettings>)
    return true
  } catch (error) {
    console.error(`[设置偏好] 持久化失败: ${key}`, error)
    set((prev) => ({ ...prev, [key]: previousValue }))
    applyPreferenceSideEffect(key, previousValue)
    return false
  }
}

/**
 * 切换界面语言并持久化；写入失败时同时回滚 atom 与 document.lang。
 * 单独提供该入口，避免其他普通偏好改变既有的乐观更新行为。
 */
export async function updateInterfaceLanguage(
  language: SettingsPreferences['interfaceLanguage'],
  previousLanguage: SettingsPreferences['interfaceLanguage'],
  set: (fn: (prev: SettingsPreferences) => SettingsPreferences) => void,
): Promise<boolean> {
  set((prev) => ({ ...prev, interfaceLanguage: language }))
  applyInterfaceLanguageToDOM(language)
  try {
    await window.electronAPI.updateSettings({ interfaceLanguage: language })
    return true
  } catch (error) {
    set((prev) => ({ ...prev, interfaceLanguage: previousLanguage }))
    applyInterfaceLanguageToDOM(previousLanguage)
    console.error('[设置偏好] 界面语言持久化失败:', error)
    return false
  }
}

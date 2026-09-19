/**
 * Settings Modal Tab Atom - 设置模态框导航状态
 *
 * 图 8 设置模态框：左侧导航分组（Settings / Desktop app / Customize），
 * 当前激活的导航页：
 * - settings-general: General（主题预览卡、代码字体、外观）
 * - privacy: Privacy（占位）
 * - usage: Usage（占位）
 * - desktop-general: 桌面端通用设置（原 GeneralSettings）
 * - desktop-developer: 开发者 / 关于（原 AboutSettings）
 * - skills: Skills（复用 Agent 技能视图入口）
 * - connectors: Connectors（原渠道配置）
 * - plugins: Plugins（原 Chat 工具配置）
 *
 * 兼容旧 SettingsTab 深链 ID：写入时映射到新页面，功能不丢失。
 */

import { atom } from 'jotai'

/** 图 8 模态框导航页 ID */
export type SettingsModalTab =
  | 'settings-general'
  | 'privacy'
  | 'usage'
  | 'claude-code'
  | 'cowork'
  | 'import-export'
  | 'desktop-general'
  | 'desktop-developer'
  | 'skills'
  | 'connectors'
  | 'plugins'

/** 旧设置面板标签页 ID（深链兼容用） */
export type LegacySettingsTab =
  | 'profile'
  | 'general'
  | 'channels'
  | 'proxy'
  | 'appearance'
  | 'about'
  | 'prompts'
  | 'tools'
  | 'bots'
  | 'tutorial'
  | 'shortcuts'
  | 'voice-input'
  | 'migration'
  | 'storage'
  | 'archived-chats'

/** 设置导航页：新 ID 或旧深链 ID（旧 ID 渲染原有页面组件） */
export type SettingsTab = SettingsModalTab | LegacySettingsTab

/** 旧深链 ID → 图 8 导航页映射；不在表中的旧 ID 保留原样渲染旧页面组件 */
const LEGACY_TAB_MAP: Partial<Record<LegacySettingsTab, SettingsModalTab>> = {
  appearance: 'settings-general',
  general: 'desktop-general',
  profile: 'desktop-general',
  about: 'desktop-developer',
  channels: 'connectors',
  tools: 'plugins',
}

/** 把任意设置标签 ID 归一化为当前导航页 */
export function normalizeSettingsTab(tab: SettingsTab): SettingsTab {
  return LEGACY_TAB_MAP[tab as LegacySettingsTab] ?? tab
}

export type ToolSettingsFocus = 'memory' | 'nano-banana' | 'custom-tools'

/** 当前设置导航页（不持久化，每次打开默认 General） */
export const settingsTabAtom = atom<SettingsTab>('settings-general')

/** Chat 工具设置页的目标配置区，用于从内置 MCP 详情直达对应配置 */
export const toolSettingsFocusAtom = atom<ToolSettingsFocus | null>(null)

/** 设置模态框是否打开 */
export const settingsOpenAtom = atom(false)

/** 渠道创建表单是否有未保存内容（用于拦截关闭模态框） */
export const channelFormDirtyAtom = atom(false)

/** 外部请求关闭设置（如 Cmd+W），SettingsModal 监听后弹出确认对话框 */
export const settingsCloseRequestedAtom = atom(false)

/** 语言选择弹窗（用户菜单 → Language） */
export const languageDialogOpenAtom = atom(false)

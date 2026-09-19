/**
 * 界面字体状态原子
 *
 * Anthropic Sans（内置栈）与系统默认字体二选一，
 * 通过 documentElement 上的 font-interface-system 类切换。
 * 持久化到 ~/.proma/settings.json 的 interfaceFont 字段。
 */

import { atom } from 'jotai'
import { DEFAULT_INTERFACE_FONT } from '../../types'
import type { InterfaceFont } from '../../types'

/** 当前界面字体选择 */
export const interfaceFontAtom = atom<InterfaceFont>(DEFAULT_INTERFACE_FONT)

/** 系统字体模式挂载在 :root 上的类名 */
export const INTERFACE_FONT_SYSTEM_CLASS = 'font-interface-system'

/** 将界面字体选择写入 :root 类 */
export function applyInterfaceFontToDOM(font: InterfaceFont): void {
  document.documentElement.classList.toggle(INTERFACE_FONT_SYSTEM_CLASS, font === 'system')
}

/**
 * 初始化界面字体
 *
 * 从主进程加载持久化设置并写入 atom + DOM。
 */
export async function initializeInterfaceFont(
  setFont: (font: InterfaceFont) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    const font = settings.interfaceFont ?? DEFAULT_INTERFACE_FONT
    setFont(font)
    applyInterfaceFontToDOM(font)
  } catch (error) {
    console.error('[界面字体] 初始化失败:', error)
    applyInterfaceFontToDOM(DEFAULT_INTERFACE_FONT)
  }
}

/**
 * 更新界面字体并持久化
 */
export async function updateInterfaceFont(font: InterfaceFont): Promise<void> {
  applyInterfaceFontToDOM(font)
  try {
    await window.electronAPI.updateSettings({ interfaceFont: font })
  } catch (error) {
    console.error('[界面字体] 持久化失败:', error)
  }
}

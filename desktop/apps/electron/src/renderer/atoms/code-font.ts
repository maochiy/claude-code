/**
 * 代码字体状态原子
 *
 * 自定义等宽字体偏好，通过 CSS 变量 --app-code-font 驱动代码块与终端字体。
 * 持久化到 ~/.proma/settings.json 的 codeFont 字段。
 */

import { atom } from 'jotai'

/** 默认等宽字体栈（与 globals.css :root 保持一致） */
export const DEFAULT_CODE_FONT_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace'

/** 当前自定义代码字体（空字符串 = 未设置，使用默认栈） */
export const codeFontAtom = atom('')

/**
 * 清洗用户输入的字体名
 *
 * 字体族会直接拼进 CSS font-family，必须剥掉引号、分号、反斜杠等
 * 可能破坏 CSS 语法或注入样式的字符。
 */
export function sanitizeCodeFont(input: string): string {
  return input.replace(/["'`;\\{}\n\r]/g, '').trim()
}

/** 拼接最终 font-family：自定义字体优先，回退默认等宽栈 */
export function buildCodeFontStack(customFont: string): string {
  const cleaned = sanitizeCodeFont(customFont)
  return cleaned ? `"${cleaned}", ${DEFAULT_CODE_FONT_STACK}` : DEFAULT_CODE_FONT_STACK
}

/** 将代码字体栈写入 :root CSS 变量 */
export function applyCodeFontToDOM(font: string): void {
  document.documentElement.style.setProperty('--app-code-font', buildCodeFontStack(font))
}

/**
 * 初始化代码字体
 *
 * 从主进程加载持久化设置并写入 atom + DOM。
 */
export async function initializeCodeFont(
  setFont: (font: string) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    const font = settings.codeFont ?? ''
    setFont(font)
    applyCodeFontToDOM(font)
  } catch (error) {
    console.error('[代码字体] 初始化失败:', error)
    applyCodeFontToDOM('')
  }
}

/**
 * 更新代码字体并持久化
 */
export async function updateCodeFont(font: string): Promise<void> {
  const cleaned = sanitizeCodeFont(font)
  applyCodeFontToDOM(cleaned)
  try {
    await window.electronAPI.updateSettings({ codeFont: cleaned })
  } catch (error) {
    console.error('[代码字体] 持久化失败:', error)
  }
}

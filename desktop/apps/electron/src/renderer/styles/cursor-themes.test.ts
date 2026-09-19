import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'

const css = readFileSync(new URL('./cursor-themes.css', import.meta.url), 'utf8')
const globals = readFileSync(new URL('./globals.css', import.meta.url), 'utf8')
const root = postcss.parse(css)
function tokensFor(style: string): Map<string, string> {
  const tokens = new Map<string, string>()
  root.walkRules((rule) => {
    if (rule.selectors.includes(`.theme-${style}`)) {
      rule.walkDecls((decl) => { tokens.set(decl.prop, decl.value) })
    }
  })
  return tokens
}

function parseColor(value: string): number[] {
  if (value.startsWith('#')) {
    return [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255)
  }
  const [hue = 0, saturation = 0, lightness = 0] = value.split(' ').map(parseFloat)
  const light = lightness / 100
  const amplitude = saturation / 100 * Math.min(light, 1 - light)
  return [0, 8, 4].map((offset) => {
    const position = (offset + hue / 30) % 12
    return light - amplitude * Math.max(-1, Math.min(position - 3, 9 - position, 1))
  })
}

function contrast(first: number[], second: number[]): number {
  const luminance = (rgb: number[]): number => rgb.reduce((sum, value, index) => {
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    return sum + linear * [0.2126, 0.7152, 0.0722][index]!
  }, 0)
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}

describe('Cursor 主题表面色与旧样式移除', () => {
  test('Given macOS 原生材质 When 切换应用主题 Then 侧栏与窗口始终使用不透明主题色', () => {
    const styles = postcss.parse(globals)
    const sidebarBackgrounds: string[] = []
    styles.walkRules((rule) => {
      if (rule.selector.includes('.cursor-sidebar-surface')) {
        rule.walkDecls('background-color', (decl) => { sidebarBackgrounds.push(decl.value) })
      }
    })
    expect(sidebarBackgrounds).toEqual(['hsl(var(--sidebar-surface))'])
    expect(globals).not.toContain('--native-window-background')
    expect(globals).not.toContain('--native-sidebar-background')
    expect(css).not.toContain('--sidebar-material-opacity')
  })

  test('Given 高对比与午夜主题 When 强调文字和删除行号显示在对应底色上 Then 小字号对比度至少为 4.5:1', () => {
    const highContrast = tokensFor('cursor-high-contrast-dark')
    const primary = parseColor(highContrast.get('--primary')!)
    expect(contrast(primary, parseColor(highContrast.get('--content-area')!))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(primary, parseColor(highContrast.get('--primary-foreground')!))).toBeGreaterThanOrEqual(4.5)

    const midnight = tokensFor('cursor-midnight-dark')
    const background = parseColor(midnight.get('--content-area')!)
    const overlay = midnight.get('--diff-removed')!
    const alpha = parseInt(overlay.slice(7, 9), 16) / 255
    const deletionBackground = parseColor(overlay).map((channel, index) => channel * alpha + background[index]! * (1 - alpha))
    expect(contrast(parseColor(midnight.get('--diff-removed-foreground')!), deletionBackground)).toBeGreaterThanOrEqual(4.5)
  })

  test('Given 主题配色文件 When 解析声明 Then 不含同规则重复覆盖或会裁剪动态主题的 Tailwind layer', () => {
    root.walkRules((rule) => {
      const properties = rule.nodes.filter((node) => node.type === 'decl').map((node) => node.prop)
      expect(new Set(properties).size).toBe(properties.length)
    })
    expect(root.nodes.some((node) => node.type === 'atrule' && node.name === 'layer')).toBe(false)
  })

  test('Given 默认深色 When 显示侧栏和内容区 Then 使用参考图的中性黑灰表面', () => {
    const tokens = tokensFor('cursor-dark')
    expect(tokens.get('--sidebar-surface')).toBe('0 0% 6.667%')
    expect(tokens.get('--content-area')).toBe('0 0% 8.235%')
    expect(tokens.get('--vscode-terminal-background')).toBe('#151515')
  })

  test('Given 默认浅色 When 显示侧栏和内容区 Then 使用纯白内容区加浅暖灰侧栏', () => {
    const tokens = tokensFor('cursor-light')
    expect(tokens.get('--sidebar-surface')).toBe('0 0% 98.4%')
    expect(tokens.get('--content-area')).toBe('0 0% 100%')
    // 现有聊天代码高亮输出浅色字，独立代码底色不能随浅色内容区变白。
    expect(tokens.get('--code-bg')).toBe('30 8% 10%')
  })

  test('Given 色盲友好主题 When 展示差异 Then 新增与删除使用蓝橙配色而非红绿', () => {
    const tokens = tokensFor('cursor-colorblind-light')
    expect(tokens.get('--diff-added-foreground')).toBe('#0066AB')
    expect(tokens.get('--diff-removed-foreground')).toBe('#A14700')
    const diffView = readFileSync(new URL('../components/diff/DiffView.tsx', import.meta.url), 'utf8')
    expect(diffView).toContain('--diffs-addition-base: var(--diff-added-foreground)')
    expect(diffView).toContain('--diffs-deletion-base: var(--diff-removed-foreground)')
  })

  test('Given 任意 Cursor 主题 When 打开输入框、弹窗、终端 Then 都提供完整的语义配色', () => {
    for (const style of ['cursor-dark', 'cursor-light', 'cursor-midnight-dark', 'cursor-high-contrast-dark', 'cursor-colorblind-light']) {
      const tokens = tokensFor(style)
      for (const token of ['--foreground', '--content-area', '--sidebar-surface', '--tabbar-surface', '--input-surface', '--dialog', '--popover', '--primary', '--ring', '--selection-background', '--vscode-terminal-background', '--vscode-terminal-ansiGreen']) {
        expect(tokens.has(token)).toBe(true)
      }
    }
  })

  test('Given 旧主题已下线 When 加载全局 CSS Then 无旧选择器、CRT 闪烁或覆盖 Cursor 的经典侧栏颜色', () => {
    expect(globals).not.toMatch(/theme-(ocean|forest|slate|terminal)-|crt-flicker|terminal-cursor-blink/)
    const classic = postcss.parse(globals)
    classic.walkRules(':root.ui-classic', (rule) => {
      expect(rule.nodes.some((node) => node.type === 'decl' && node.prop === '--sidebar-surface')).toBe(false)
    })
    expect(globals).toContain('background: hsl(var(--content-area) / 0.75)')
  })
})

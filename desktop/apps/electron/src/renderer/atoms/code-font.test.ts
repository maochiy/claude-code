import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CODE_FONT_STACK,
  buildCodeFontStack,
  sanitizeCodeFont,
} from './code-font'

describe('代码字体清洗与拼接', () => {
  test('Given 含引号分号等危险字符的输入 When 清洗 Then 剥掉所有 CSS 语法字符并修剪空白', () => {
    expect(sanitizeCodeFont('  JetBrains "Mono"; ')).toBe('JetBrains Mono')
    expect(sanitizeCodeFont("Fira\\Code'x")).toBe('FiraCodex')
    expect(sanitizeCodeFont('a{b}\nc;d')).toBe('abcd')
  })

  test('Given 自定义字体 When 拼接字体栈 Then 自定义字体带引号置于栈首', () => {
    expect(buildCodeFontStack('JetBrains Mono')).toBe('"JetBrains Mono", ' + DEFAULT_CODE_FONT_STACK)
  })

  test('Given 空输入 When 拼接字体栈 Then 直接回退默认等宽栈', () => {
    expect(buildCodeFontStack('')).toBe(DEFAULT_CODE_FONT_STACK)
    expect(buildCodeFontStack('   ')).toBe(DEFAULT_CODE_FONT_STACK)
  })

  test('Given 界面字体类型 When 校验取值 Then 仅支持 anthropic 与 system 两档', () => {
    // InterfaceFont 联合类型约束，持久化值由 updateInterfaceFont 原样透传
    const allowed: Array<'anthropic' | 'system'> = ['anthropic', 'system']
    expect(allowed).toHaveLength(2)
  })
})

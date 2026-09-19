import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('Nowledge Mem Hooks 配置入口', () => {
  test('Given 用户复制设置页提示词 When 配置 Hooks Then 指向原生 CLI 实际配置且不再使用旧 SDK 目录', () => {
    const prompt = readFileSync(new URL('./nowledge-mem-prompt.md', import.meta.url), 'utf8')

    expect(prompt).toContain('$CLAUDE_CONFIG_DIR/settings.json')
    expect(prompt).toContain('~/.claude/settings.json')
    expect(prompt).not.toContain('~/xcodes/sdk-config/.claude/settings.json')
  })
})

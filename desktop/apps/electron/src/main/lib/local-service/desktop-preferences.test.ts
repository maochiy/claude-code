import { describe, expect, test } from 'bun:test'
import { buildDesktopCliPreferences } from './desktop-preferences'

describe('桌面偏好进入原生 CLI', () => {
  test('开启沙箱必须在不可用时失败，严格模式不允许逃逸到沙箱外', () => {
    expect(buildDesktopCliPreferences({ localSandboxEnabled: true, strictSandboxMode: true }).settings)
      .toEqual({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } })
    expect(buildDesktopCliPreferences({ localSandboxEnabled: true }).settings)
      .toEqual({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: true } })
  })
  test('默认值不关闭原生项目沙箱，不凭空增加输出风格要求', () => {
    expect(buildDesktopCliPreferences({})).toMatchObject({ settings: {}, systemPrompt: '' })
    expect(buildDesktopCliPreferences({ localSandboxEnabled: false }).settings).toEqual({})
  })
  test('动态工作流只影响当前 CLI 进程的并行子代理策略', () => {
    expect(buildDesktopCliPreferences({}).environment).toEqual({ CLAUDE_CODE_DYNAMIC_WORKFLOWS_ENABLED: '0' })
    expect(buildDesktopCliPreferences({ dynamicWorkflowsEnabled: true }).environment)
      .toEqual({ CLAUDE_CODE_DYNAMIC_WORKFLOWS_ENABLED: '1' })
  })
  test('两种非默认输出风格进入系统指令', () => {
    expect(buildDesktopCliPreferences({ outputStyle: 'concise' }).systemPrompt).toContain('concise')
    expect(buildDesktopCliPreferences({ outputStyle: 'detailed' }).systemPrompt).toContain('detailed')
  })
  test('用户选择的工作类型进入新 CLI 会话上下文', () => {
    const preferences = buildDesktopCliPreferences({ workType: 'Software development' })

    expect(preferences.systemPrompt).toContain('Software development')
    expect(preferences.systemPrompt).toContain('examples and terminology')
  })
})

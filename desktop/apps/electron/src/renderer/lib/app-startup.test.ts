import { describe, expect, test } from 'bun:test'
import {
  applyOptionalOpenSwitchAuthResult,
  checkOptionalOpenSwitchAuth,
  loadLocalDesktopStartup,
  resolveLocalDesktopView,
} from './app-startup'

describe('本地桌面启动与可选 OpenSwitch 账号', () => {
  test('Given 未登录 OpenSwitch When 本地初始化完成 Then 直接进入桌面', () => {
    expect(resolveLocalDesktopView({
      isLoading: false,
      showOnboarding: false,
    })).toBe('app')
  })

  test('Given OpenSwitch 检查失败 When 本地设置已加载 Then 保留已确认账号且继续进入桌面', async () => {
    const result = await checkOptionalOpenSwitchAuth(async () => {
      throw new Error('network unavailable')
    })
    const previous = {
      authenticated: true,
      channelId: 'existing-openswitch-channel',
      defaultModelId: 'existing-model',
    }

    expect(applyOptionalOpenSwitchAuthResult(previous, result)).toMatchObject(previous)
    expect(resolveLocalDesktopView({
      isLoading: false,
      showOnboarding: false,
    })).toBe('app')
  })

  test('Given 用户退出 OpenSwitch When 返回设置 Then 本地桌面仍保持打开', () => {
    expect(resolveLocalDesktopView({
      isLoading: false,
      showOnboarding: false,
    })).toBe('app')
  })

  test('Given 首次使用尚未完成引导 When OpenSwitch 未登录 Then 仍显示本地引导', () => {
    expect(resolveLocalDesktopView({
      isLoading: false,
      showOnboarding: true,
    })).toBe('onboarding')
  })

  test('Given OpenSwitch 检查永不返回 When 本地设置完成 Then 本地桌面仍完成启动', async () => {
    void checkOptionalOpenSwitchAuth(() => new Promise(() => {}))

    const local = await loadLocalDesktopStartup(async () => ({ onboardingCompleted: true }))

    expect(local).toEqual({ showOnboarding: false })
    expect(resolveLocalDesktopView({
      isLoading: false,
      showOnboarding: local.showOnboarding,
    })).toBe('app')
  })
})

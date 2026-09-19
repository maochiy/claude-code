import type { NewApiAuthState } from '@/types/new-api-auth'

export interface OptionalOpenSwitchAuthSuccess {
  status: 'success'
  auth: NewApiAuthState
}

export interface OptionalOpenSwitchAuthFailure {
  status: 'failure'
  warning: string
}

export type OptionalOpenSwitchAuthResult =
  | OptionalOpenSwitchAuthSuccess
  | OptionalOpenSwitchAuthFailure

export type LocalDesktopView = 'loading' | 'onboarding' | 'app'

interface LocalDesktopViewInput {
  isLoading: boolean
  showOnboarding: boolean
}

interface LocalDesktopSettings {
  onboardingCompleted?: boolean
}

export interface LocalDesktopStartupResult {
  showOnboarding: boolean
  error?: unknown
}

const OPEN_SWITCH_CHECK_WARNING = 'OpenSwitch 账号状态检查失败，可稍后在设置中重试'

/**
 * OpenSwitch 检查失败时返回非阻塞结果，避免网络或账号服务影响本地桌面初始化。
 */
export async function checkOptionalOpenSwitchAuth(
  check: () => Promise<NewApiAuthState>,
): Promise<OptionalOpenSwitchAuthResult> {
  try {
    return { status: 'success', auth: await check() }
  } catch {
    return { status: 'failure', warning: OPEN_SWITCH_CHECK_WARNING }
  }
}

/**
 * 检查失败只附加提示，保留最后一次已经确认的登录信息。
 */
export function applyOptionalOpenSwitchAuthResult(
  current: NewApiAuthState,
  result: OptionalOpenSwitchAuthResult,
): NewApiAuthState {
  if (result.status === 'success') return result.auth
  return { ...current, warning: result.warning }
}

/** 本地设置是桌面启动的唯一异步前置条件，与可选账号检查完全独立。 */
export async function loadLocalDesktopStartup(
  loadSettings: () => Promise<LocalDesktopSettings>,
): Promise<LocalDesktopStartupResult> {
  try {
    const settings = await loadSettings()
    return { showOnboarding: !settings.onboardingCompleted }
  } catch (error) {
    return { showOnboarding: false, error }
  }
}

/** Local 是默认入口，OpenSwitch 登录状态不会改变页面路由。 */
export function resolveLocalDesktopView(input: LocalDesktopViewInput): LocalDesktopView {
  if (input.isLoading) return 'loading'
  if (input.showOnboarding) return 'onboarding'
  return 'app'
}

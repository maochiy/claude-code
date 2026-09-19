import * as React from 'react'
import { useAtom, useStore } from 'jotai'
import { AppShell } from './components/app-shell/AppShell'
import { OnboardingView } from './components/onboarding/OnboardingView'
import { TutorialBanner } from './components/tutorial/TutorialBanner'
import { EnvironmentCheckDialog } from './components/environment/EnvironmentCheckDialog'
import { MigrationImportDialog } from './components/migration/MigrationImportDialog'
import { TooltipProvider } from './components/ui/tooltip'
import { appModeAtom } from './atoms/app-mode'
import { environmentCheckDialogOpenAtom } from './atoms/environment'
import { tabsAtom, activeTabIdAtom, openTab, TUTORIAL_TAB_ID } from './atoms/tab-atoms'
import { userProfileAtom } from './atoms/user-profile'
import { newApiAuthAtom } from './atoms/new-api-auth'
import {
  applyOptionalOpenSwitchAuthResult,
  checkOptionalOpenSwitchAuth,
  loadLocalDesktopStartup,
  resolveLocalDesktopView,
} from './lib/app-startup'
import { useTranslation } from './lib/i18n'
import type { AppShellContextType } from './contexts/AppShellContext'
import type { NewApiAuthState } from '../types'

export default function App(): React.ReactElement {
  // 应用级初始化状态。

  const { t } = useTranslation()
  const store = useStore()
  const [newApiAuth, setNewApiAuth] = useAtom(newApiAuthAtom)
  const [isLoading, setIsLoading] = React.useState(true)
  const [showOnboarding, setShowOnboarding] = React.useState(false)

  const applyAuthenticatedState = React.useCallback((auth: NewApiAuthState): void => {
    if (auth.profile) {
      store.set(userProfileAtom, auth.profile)
    }
    setNewApiAuth(auth)
  }, [setNewApiAuth, store])

  // 本地设置独立初始化；可选账号检查无论失败、缓慢或不返回都不能阻塞 Local。
  // macOS/Linux 上 SDK 自带 claude native binary 不依赖宿主 Node/Git；
  // Windows 上仍需 Git Bash/WSL，由 Onboarding Step 2 与聊天错误卡片引导用户安装。
  React.useEffect(() => {
    let mounted = true
    const initializeLocalDesktop = async (): Promise<void> => {
      const result = await loadLocalDesktopStartup(() => window.electronAPI.getSettings())
      if (!mounted) return
      if (result.error) console.error('[App] 加载本地设置失败:', result.error)
      setShowOnboarding(result.showOnboarding)
      setIsLoading(false)
    }

    void initializeLocalDesktop()
    return () => { mounted = false }
  }, [])

  React.useEffect(() => {
    let mounted = true
    const refreshOptionalAccount = async (): Promise<void> => {
      const authResult = await checkOptionalOpenSwitchAuth(() => window.electronAPI.checkNewApiAuth())
      if (!mounted) return
      if (authResult.status === 'success') {
        applyAuthenticatedState(authResult.auth)
        return
      }
      console.warn(`[App] ${authResult.warning}`)
      setNewApiAuth((current) => applyOptionalOpenSwitchAuthResult(current, authResult))
    }

    void refreshOptionalAccount()
    return () => { mounted = false }
  }, [applyAuthenticatedState, setNewApiAuth])

  // 完成引导后进入代码首页；教程仅在用户明确选择时打开。
  const handleOnboardingComplete = async (openTutorial?: boolean) => {
    setShowOnboarding(false)

    if (openTutorial) {
      const tabs = store.get(tabsAtom)
      const result = openTab(tabs, {
        type: 'tutorial',
        sessionId: TUTORIAL_TAB_ID,
        title: t('tutorialBanner.title'),
      })
      store.set(tabsAtom, result.tabs)
      store.set(activeTabIdAtom, result.activeTabId)
      return
    }

    store.set(appModeAtom, 'agent')
    store.set(activeTabIdAtom, null)
  }

  const desktopView = resolveLocalDesktopView({
    isLoading,
    showOnboarding,
  })

  if (desktopView === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">{t('app.initializing')}</p>
        </div>
      </div>
    )
  }

  if (desktopView === 'onboarding') {
    return (
      <TooltipProvider delayDuration={200}>
        <OnboardingView onComplete={handleOnboardingComplete} />
        <MigrationImportDialog />
      </TooltipProvider>
    )
  }

  // Placeholder context value
  const contextValue: AppShellContextType = {}

  // 显示主界面
  return (
    <TooltipProvider delayDuration={200}>
      <AppShell contextValue={contextValue} />
      <TutorialBanner />
      <GlobalEnvironmentCheckDialog />
      <MigrationImportDialog />
    </TooltipProvider>
  )
}

/**
 * 全局环境检测 Dialog，由错误卡片的 recovery action 按钮打开。
 */
function GlobalEnvironmentCheckDialog(): React.ReactElement {
  const [open, setOpen] = useAtom(environmentCheckDialogOpenAtom)
  return <EnvironmentCheckDialog open={open} onOpenChange={setOpen} />
}

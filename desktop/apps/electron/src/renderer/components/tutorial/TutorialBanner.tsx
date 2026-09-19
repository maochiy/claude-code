/**
 * TutorialBanner - 教程推荐横幅
 *
 * 固定在右下角的浮动卡片，引导用户查看教程。
 * - 不区分新老用户，使用 tutorialBannerDismissed 字段控制
 * - 用户点击「立即学习」或「稍后再学」后永不再显示
 * - 明确告知教程的下次访问位置：设置 > 教程
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { GraduationCap, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { tabsAtom, activeTabIdAtom, openTab, TUTORIAL_TAB_ID } from '@/atoms/tab-atoms'
import { useTranslation } from '@/lib/i18n'

interface TutorialBannerContentProps {
  visible: boolean
  onLearnNow: () => void
  onLater: () => void
}

export function TutorialBannerContent({
  visible,
  onLearnNow,
  onLater,
}: TutorialBannerContentProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div
      className={`fixed bottom-6 right-6 z-[100] w-[340px] transition-all duration-500 ease-out ${
        visible
          ? 'translate-x-0 opacity-100'
          : 'translate-x-8 opacity-0 pointer-events-none'
      }`}
    >
      <div className="relative rounded-2xl bg-gradient-to-br from-primary/5 via-background to-primary/10 border border-primary/15 shadow-lg shadow-primary/5 backdrop-blur-sm p-5">
        <button
          type="button"
          aria-label={t('tutorialBanner.close')}
          onClick={onLater}
          className="absolute top-3 right-3 p-1 rounded-lg text-muted-foreground/50 hover:text-muted-foreground hover:bg-foreground/5 transition-colors"
        >
          <X size={14} />
        </button>

        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <GraduationCap size={20} className="text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              {t('tutorialBanner.title')}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('tutorialBanner.description')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={onLearnNow}
            className="flex-1 h-8 text-xs"
          >
            {t('tutorialBanner.learnNow')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onLater}
            className="h-8 text-xs text-muted-foreground"
          >
            {t('tutorialBanner.later')}
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground/60 mt-3 text-center">
          {t('tutorialBanner.reopenHint')}
        </p>
      </div>
    </div>
  )
}

export function TutorialBanner(): React.ReactElement | null {
  const [visible, setVisible] = React.useState(false)
  const [dismissed, setDismissed] = React.useState(true)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const { t } = useTranslation()

  React.useEffect(() => {
    window.electronAPI
      .getSettings()
      .then((settings) => {
        if (!settings.tutorialBannerDismissed) {
          setDismissed(false)
          setTimeout(() => setVisible(true), 1500)
        }
      })
      .catch(console.error)
  }, [])

  const handleDismiss = async () => {
    setVisible(false)
    await window.electronAPI.updateSettings({ tutorialBannerDismissed: true })
  }

  const handleLearnNow = async () => {
    const result = openTab(tabs, {
      type: 'tutorial',
      sessionId: TUTORIAL_TAB_ID,
      title: t('tutorialBanner.title'),
    })
    setTabs(result.tabs)
    setActiveTabId(result.activeTabId)
    await handleDismiss()
  }

  // 稍后再学：关闭横幅
  const handleLater = async () => {
    await handleDismiss()
  }

  if (dismissed) return null

  return (
    <TutorialBannerContent
      visible={visible}
      onLearnNow={() => void handleLearnNow()}
      onLater={() => void handleLater()}
    />
  )
}

/**
 * Onboarding 视图组件
 *
 * 首次启动时显示的全屏欢迎界面。
 *
 * 流程：
 *  Step 1：欢迎 + 教程入口
 *  Step 2：Windows 环境检测（仅 Windows，其他平台自动跳过）
 */

import { useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { GraduationCap, ChevronRight, ChevronLeft, HardDriveDownload, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EnvironmentCheckPanel } from '@/components/environment/EnvironmentCheckPanel'
import { isShellEnvironmentOkAtom } from '@/atoms/environment'
import { detectIsWindows } from '@/lib/platform'
import { migrationImportDialogOpenAtom } from '@/atoms/migration-atoms'
import { useTranslation } from '@/lib/i18n'

interface OnboardingViewProps {
  onComplete: (openTutorial?: boolean) => void
}

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [step, setStep] = useState<'welcome' | 'environment'>('welcome')
  const isWindows = useMemo(() => detectIsWindows(), [])
  const shellOk = useAtomValue(isShellEnvironmentOkAtom)
  const setMigrationImportDialogOpen = useSetAtom(migrationImportDialogOpenAtom)
  const { t } = useTranslation()

  const handleFinish = async (openTutorial?: boolean) => {
    await window.electronAPI.updateSettings({ onboardingCompleted: true })
    onComplete(openTutorial)
  }

  const handleNextFromWelcome = () => {
    if (isWindows) {
      setStep('environment')
    } else {
      handleFinish()
    }
  }

  const handleOpenMigration = () => {
    setMigrationImportDialogOpen(true)
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-gradient-to-br from-background via-background to-muted/20 p-8">
      {step === 'welcome' && (
        <>
          <div className="mb-12 text-center">
            <h1 className="text-4xl font-bold mb-4">{t('onboarding.welcome')}</h1>
            <p className="text-lg text-muted-foreground">
              {t('onboarding.tagline')}
            </p>
          </div>

          <div className="w-full max-w-2xl">
            <div className="space-y-3">
              <button
                onClick={() => handleFinish(true)}
                className="w-full rounded-xl bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 border border-primary/15 p-4 flex items-center gap-4 hover:from-primary/10 hover:via-primary/15 hover:to-primary/10 transition-colors text-left"
              >
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <GraduationCap size={20} className="text-primary" />
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-foreground">
                    {t('onboarding.tutorialTitle')}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('onboarding.tutorialDescription')}
                  </p>
                </div>
              </button>

              <p className="text-sm text-muted-foreground pt-2">
                {t('onboarding.migrationPrompt')}
              </p>

              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={handleOpenMigration}
                  className="rounded-xl bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 border border-primary/15 p-4 flex items-center gap-3 hover:from-primary/10 hover:via-primary/15 hover:to-primary/10 transition-colors text-left"
                >
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <HardDriveDownload size={20} className="text-primary" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-foreground">
                      {t('onboarding.deviceTitle')}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t('onboarding.deviceDescription')}
                      <br/>
                      <br/>
                      {t('onboarding.deviceHint')}
                    </p>
                  </div>
                </button>
                <button
                  onClick={handleOpenMigration}
                  className="rounded-xl bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 border border-primary/15 p-4 flex items-center gap-3 hover:from-primary/10 hover:via-primary/15 hover:to-primary/10 transition-colors text-left"
                >
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Users size={20} className="text-primary" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-foreground">
                      {t('onboarding.userTitle')}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t('onboarding.userDescription')}
                      <br/>
                      <br/>
                      {t('onboarding.userHint')}
                    </p>
                  </div>
                </button>
              </div>
            </div>
          </div>

          <div className="w-full max-w-2xl mt-8 flex flex-col items-center gap-2">
            <Button className="w-full h-12 text-base" onClick={handleNextFromWelcome}>
              {isWindows ? (
                <>
                  {t('onboarding.nextEnvironment')}
                  <ChevronRight className="ml-1 h-4 w-4" />
                </>
              ) : (
                t('onboarding.start')
              )}
            </Button>
            <p className="text-xs text-muted-foreground/60">
              {t('onboarding.settingsHint')}
            </p>
          </div>
        </>
      )}

      {step === 'environment' && isWindows && (
        <div className="w-full max-w-2xl">
          <div className="mb-6 text-center">
            <h2 className="text-2xl font-semibold mb-2">
              {t('onboarding.environmentTitle')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('onboarding.environmentDescription')}
            </p>
          </div>

          <div className="rounded-xl border bg-card p-5 mb-6">
            <EnvironmentCheckPanel autoDetectOnMount />
          </div>

          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep('welcome')}
              className="text-muted-foreground"
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              {t('onboarding.back')}
            </Button>
            <div className="flex gap-3">
              <Button
                onClick={() => handleFinish()}
                variant={shellOk ? 'default' : 'outline'}
              >
                {shellOk ? t('onboarding.start') : t('onboarding.later')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

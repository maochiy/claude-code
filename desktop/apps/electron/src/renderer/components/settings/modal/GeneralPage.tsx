/**
 * GeneralPage - 设置模态框 General 页（对齐参考截图）
 *
 * - Profile：头像 + 用户名 + 「What best describes your work?」
 * - Instructions：全局自定义指令（注入 Agent 系统提示词）
 * - Preferences：外观（跟随系统/浅色/深色）、Chat font、Motion
 * - Notifications：回复完成通知开关
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Monitor, Moon, Sun } from 'lucide-react'
import { toast } from 'sonner'
import {
  systemIsDarkAtom,
  themeModeAtom,
  themeStyleAtom,
  updateThemeSelection,
  applyThemeToDOM,
} from '@/atoms/theme'
import { userProfileAtom } from '@/atoms/user-profile'
import {
  settingsPreferencesAtom,
  updateSettingsPreference,
} from '@/atoms/settings-preferences'
import type { SettingsPreferences } from '@/atoms/settings-preferences'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { ModalSegmented, ModalSettingRow, ModalSwitch } from './SettingsModalControls'
import { cn } from '@/lib/utils'
import { resolveThemeAppearance, type ThemeMode } from '../../../../types'
import { useTranslation, type TranslationKey } from '@/lib/i18n'

/** 工作类型选项（参考桌面端 Profile Select） */
const WORK_TYPE_OPTIONS: Array<{ value: string; labelKey: TranslationKey }> = [
  { value: 'Software development', labelKey: 'work.software' },
  { value: 'Data & analysis', labelKey: 'work.data' },
  { value: 'Writing & communication', labelKey: 'work.writing' },
  { value: 'Design', labelKey: 'work.design' },
  { value: 'Product & project management', labelKey: 'work.product' },
  { value: 'Research & education', labelKey: 'work.research' },
  { value: 'Something else', labelKey: 'work.other' },
] as const

/** 参考样式的外观三选一图标分段（跟随系统 / 浅色 / 深色） */
function AppearanceSegmented({ value, onChange }: {
  value: ThemeMode
  onChange: (value: ThemeMode) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const options: Array<{ value: ThemeMode; icon: React.ReactNode; label: string }> = [
    { value: 'system', icon: <Monitor className="size-4" />, label: t('general.system') },
    { value: 'light', icon: <Sun className="size-4" />, label: t('general.light') },
    { value: 'dark', icon: <Moon className="size-4" />, label: t('general.dark') },
  ]
  return (
    <div role="radiogroup" aria-label="Appearance" className="flex items-center gap-0.5 rounded-lg bg-foreground/[0.06] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          title={option.label}
          onClick={() => onChange(option.value)}
          className={cn(
            'flex size-7 items-center justify-center rounded-[7px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45',
            value === option.value
              ? 'bg-background text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.icon}
        </button>
      ))}
    </div>
  )
}

export function GeneralPage(): React.ReactElement {
  const { t } = useTranslation()
  const themeMode = useAtomValue(themeModeAtom)
  const themeStyle = useAtomValue(themeStyleAtom)
  const setThemeMode = useSetAtom(themeModeAtom)
  const setThemeStyle = useSetAtom(themeStyleAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)
  const userProfile = useAtomValue(userProfileAtom)

  const prefs = useAtomValue(settingsPreferencesAtom)
  const setPrefs = useSetAtom(settingsPreferencesAtom)
  const updatePref = React.useCallback(<K extends keyof SettingsPreferences>(
    key: K,
    value: SettingsPreferences[K],
  ): void => {
    void updateSettingsPreference(key, value, setPrefs).then((saved) => {
      if (!saved) toast.error(t('general.preferenceSaveFailed'))
    })
  }, [setPrefs, t])

  // 普通主题模式统一归一为 default 配色并持久化，避免残留 special 风格。
  const appearanceMode: ThemeMode = themeMode === 'special'
    ? resolveThemeAppearance(themeMode, themeStyle, systemIsDark)
    : themeMode

  const handleThemeModeChange = React.useCallback((mode: ThemeMode): void => {
    const previousMode = themeMode
    const previousStyle = themeStyle
    setThemeMode(mode)
    setThemeStyle('default')
    applyThemeToDOM(mode, 'default', systemIsDark)
    void updateThemeSelection(mode, 'default').catch((error: unknown) => {
      console.error('[设置] 主题模式保存失败:', error)
      setThemeMode(previousMode)
      setThemeStyle(previousStyle)
      applyThemeToDOM(previousMode, previousStyle, systemIsDark)
      toast.error(t('general.themeSaveFailed'))
    })
  }, [setThemeMode, setThemeStyle, systemIsDark, t, themeMode, themeStyle])

  // 自定义指令草稿（失焦/Enter 时落盘）
  const [instructionsDraft, setInstructionsDraft] = React.useState(prefs.customInstructions)
  React.useEffect(() => { setInstructionsDraft(prefs.customInstructions) }, [prefs.customInstructions])
  const commitInstructions = (): void => {
    if (instructionsDraft !== prefs.customInstructions) {
      updatePref('customInstructions', instructionsDraft)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[712px] pb-10 pt-8" data-settings-page="general">
      <h1 className="text-[17px] font-semibold text-foreground">{t('general.profile')}</h1>

      {/* 头像 + 用户名 */}
      <div className="mt-4 flex items-center justify-between border-b border-border/60 pb-5">
        <span className="text-[14px] text-foreground">{t('general.avatar')}</span>
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] text-muted-foreground">{userProfile.userName}</span>
          <UserAvatar avatar={userProfile.avatar} size={36} />
        </div>
      </div>

      {/* 工作类型 */}
      <div className="flex items-center justify-between gap-6 border-b border-border/60 py-4">
        <span className="text-[14px] text-foreground">{t('general.workQuestion')}</span>
        <select
          value={prefs.workType}
          aria-label={t('general.workQuestion')}
          onChange={(event) => updatePref('workType', event.target.value)}
          className="h-[30px] min-w-[150px] cursor-pointer appearance-none rounded-lg border border-border bg-background px-3 pr-7 text-[13px] text-foreground outline-none transition-colors focus:border-foreground/30 [background-image:url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2210%22%20height%3D%226%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22m1%201%204%204%204-4%22%20stroke%3D%22%23888%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E')] [background-position:right_10px_center] [background-repeat:no-repeat]"
        >
          <option value="">{t('general.select')}</option>
          {WORK_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
          ))}
        </select>
      </div>

      {/* 全局自定义指令 */}
      <h2 className="mt-8 text-[15px] font-semibold text-foreground">{t('general.instructions')}</h2>
      <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
        {t('general.instructionsDescription')}
      </p>
      <textarea
        value={instructionsDraft}
        onChange={(event) => setInstructionsDraft(event.target.value)}
        onBlur={commitInstructions}
        placeholder={t('general.instructionsPlaceholder')}
        aria-label={t('general.instructions')}
        spellCheck={false}
        rows={4}
        className="mt-3 w-full resize-none rounded-lg border border-border bg-background px-3 py-2.5 text-[13px] leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-foreground/30"
      />

      {/* Preferences */}
      <h2 className="mt-8 text-[15px] font-semibold text-foreground">{t('general.preferences')}</h2>
      <div className="mt-1 divide-y divide-border/60">
        <ModalSettingRow label={t('general.appearance')}>
          <AppearanceSegmented value={appearanceMode} onChange={handleThemeModeChange} />
        </ModalSettingRow>
        <ModalSettingRow label={t('general.chatFont')}>
          <select
            value={prefs.chatFont}
            aria-label={t('general.chatFont')}
            onChange={(event) => updatePref('chatFont', event.target.value)}
            className="h-[30px] min-w-[170px] cursor-pointer appearance-none rounded-lg border border-border bg-background px-3 pr-7 text-[13px] text-foreground outline-none transition-colors focus:border-foreground/30 [background-image:url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2210%22%20height%3D%226%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22m1%201%204%204%204-4%22%20stroke%3D%22%23888%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E')] [background-position:right_10px_center] [background-repeat:no-repeat]"
          >
            <option value="">Anthropic Serif</option>
            <option value="system">{t('general.system')}</option>
          </select>
        </ModalSettingRow>
        <ModalSettingRow
          label={t('general.motion')}
          description={t('general.motionDescription')}
        >
          <ModalSegmented
            value={prefs.motionPreference}
            ariaLabel={t('general.motion')}
            onChange={(value) => updatePref('motionPreference', value)}
            options={[
              { value: 'system', label: t('general.system') },
              { value: 'reduced', label: t('general.reduced') },
            ]}
          />
        </ModalSettingRow>
      </div>

      {/* Notifications */}
      <h2 className="mt-8 text-[15px] font-semibold text-foreground">{t('general.notifications')}</h2>
      <div className="mt-1 divide-y divide-border/60">
        <ModalSettingRow
          label={t('general.responseCompletions')}
          description={t('general.responseCompletionsDescription')}
        >
          <ModalSwitch
            checked={prefs.responseCompletionNotification}
            onCheckedChange={(checked) => updatePref('responseCompletionNotification', checked)}
            ariaLabel={t('general.responseCompletions')}
          />
        </ModalSettingRow>
      </div>
    </div>
  )
}

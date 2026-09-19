/**
 * ClaudeCodePage - 设置模态框 Claude Code 页（对齐参考截图）
 *
 * - Code appearance：Light / Dark 主题预览卡
 * - Code font：自定义等宽字体输入
 * - Appearance：界面字体、正文字号、正文宽度
 * - Local sessions：bypass 模式开关、动态工作流、通知弹跳、防唤醒、自动归档、
 *   worktree 位置、输出风格、本地沙箱
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  systemIsDarkAtom,
  themeModeAtom,
  themeStyleAtom,
  updateThemeSelection,
  applyThemeToDOM,
} from '@/atoms/theme'
import {
  markdownFontSizeAtom,
  updateMarkdownFontSize,
} from '@/atoms/markdown-font-size'
import {
  codeFontAtom,
  sanitizeCodeFont,
  updateCodeFont,
} from '@/atoms/code-font'
import {
  interfaceFontAtom,
  updateInterfaceFont,
} from '@/atoms/interface-font'
import {
  settingsPreferencesAtom,
  updateSettingsPreference,
} from '@/atoms/settings-preferences'
import type { SettingsPreferences } from '@/atoms/settings-preferences'
import { ModalSegmented, ModalSettingRow, ModalSwitch } from './SettingsModalControls'
import { ThemePreviewCard } from './ThemePreviewCard'
import type { InterfaceFont, MarkdownFontSize, ThemeMode, ThemeStyle } from '../../../../types'
import { useTranslation } from '@/lib/i18n'

/** 高对比深色主题 ID */
const HIGH_CONTRAST_STYLE: ThemeStyle = 'cursor-high-contrast-dark'

/** 通用下拉选择（对齐参考的 Select 样式） */
function ModalSelect<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  ariaLabel: string
}): React.ReactElement {
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value as T)}
      className="h-[30px] min-w-[150px] cursor-pointer appearance-none rounded-lg border border-border bg-background px-3 pr-7 text-[13px] text-foreground outline-none transition-colors focus:border-foreground/30 [background-image:url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2210%22%20height%3D%226%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22m1%201%204%204%204-4%22%20stroke%3D%22%23888%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E')] [background-position:right_10px_center] [background-repeat:no-repeat]"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  )
}

export function ClaudeCodePage(): React.ReactElement {
  const { language, t } = useTranslation()
  const text = (chinese: string, english: string): string => language === 'zh' ? chinese : english
  const themeMode = useAtomValue(themeModeAtom)
  const themeStyle = useAtomValue(themeStyleAtom)
  const setThemeMode = useSetAtom(themeModeAtom)
  const setThemeStyle = useSetAtom(themeStyleAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)
  const [isSavingTheme, setIsSavingTheme] = React.useState(false)

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

  const selectedStyle: ThemeStyle = themeMode === 'special' && themeStyle !== 'default'
    ? themeStyle
    : (themeMode === 'dark' || (themeMode === 'system' && systemIsDark))
      ? 'cursor-dark'
      : 'cursor-light'

  /** 模式和配色一次持久化，避免其他窗口短暂收到不完整的主题。 */
  const handleThemeSelect = async (mode: ThemeMode, style: ThemeStyle): Promise<void> => {
    if (isSavingTheme) return
    setIsSavingTheme(true)
    setThemeMode(mode)
    setThemeStyle(style)
    applyThemeToDOM(mode, style, systemIsDark)
    try {
      await updateThemeSelection(mode, style)
    } catch {
      setThemeMode(themeMode)
      setThemeStyle(themeStyle)
      applyThemeToDOM(themeMode, themeStyle, systemIsDark)
      toast.error(t('general.themeSaveFailed'))
    } finally {
      setIsSavingTheme(false)
    }
  }

  /** 高对比深色开关：开启切 high-contrast，关闭回到普通深色 */
  const highContrastActive = selectedStyle === HIGH_CONTRAST_STYLE
  const handleHighContrastChange = (checked: boolean): void => {
    if (checked) {
      void handleThemeSelect('special', HIGH_CONTRAST_STYLE)
      return
    }
    void handleThemeSelect('special', selectedStyle === HIGH_CONTRAST_STYLE ? 'cursor-dark' : selectedStyle)
  }

  // ===== 代码字体 =====
  const codeFont = useAtomValue(codeFontAtom)
  const [fontDraft, setFontDraft] = React.useState(codeFont)
  React.useEffect(() => { setFontDraft(codeFont) }, [codeFont])
  const commitCodeFont = (): void => {
    if (sanitizeCodeFont(fontDraft) !== codeFont) {
      void updateCodeFont(fontDraft)
    }
  }

  // ===== 界面字体 =====
  const [interfaceFont, setInterfaceFont] = useAtom(interfaceFontAtom)
  const handleInterfaceFontChange = (font: InterfaceFont): void => {
    setInterfaceFont(font)
    void updateInterfaceFont(font)
  }

  // ===== 正文字号 =====
  const [markdownFontSize, setMarkdownFontSize] = useAtom(markdownFontSizeAtom)
  const handleFontSizeChange = (size: MarkdownFontSize): void => {
    setMarkdownFontSize(size)
    void updateMarkdownFontSize(size)
  }

  return (
    <div className="mx-auto w-full max-w-[712px] pb-10 pt-8" data-settings-page="claude-code">
      <h1 className="text-[17px] font-semibold text-foreground">Claude Code</h1>

      <h2 className="mt-7 text-[15px] font-semibold text-foreground">{text('代码外观', 'Code appearance')}</h2>
      <div className="mt-3 grid grid-cols-2 gap-[19px]">
        <ThemePreviewCard
          label={t('general.light')}
          dark={false}
          selected={!isSavingTheme && selectedStyle === 'cursor-light'}
          onSelect={() => void handleThemeSelect('special', 'cursor-light')}
        />
        <ThemePreviewCard
          label={t('general.dark')}
          dark
          selected={!isSavingTheme && selectedStyle === 'cursor-dark'}
          onSelect={() => void handleThemeSelect('special', 'cursor-dark')}
        />
      </div>

      <div className="mt-7 border-t border-border/60">
        <ModalSettingRow
          label={text('代码字体', 'Code font')}
          description={text('为代码和终端设置自定义等宽字体。', 'Set a custom monospace font for code and terminal.')}
        >
          <input
            value={fontDraft}
            onChange={(event) => setFontDraft(event.target.value)}
            onBlur={commitCodeFont}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
            placeholder={text('例如 JetBrains Mono', 'e.g. JetBrains Mono')}
            aria-label={text('代码字体', 'Code font')}
            data-code-font-input
            spellCheck={false}
            className="h-[38px] w-[221px] rounded-lg border border-border bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-foreground/30"
          />
        </ModalSettingRow>
      </div>

      <h2 className="mt-8 text-[15px] font-semibold text-foreground">{t('general.appearance')}</h2>
      <div className="mt-1 divide-y divide-border/60">
        <ModalSettingRow
          label={text('高对比度深色主题', 'High-contrast dark theme')}
          description={text('深色模式下使用更深、接近黑色的背景。', 'Use a darker, near-black background when dark mode is on.')}
        >
          <ModalSwitch
            checked={highContrastActive}
            onCheckedChange={handleHighContrastChange}
            ariaLabel={text('高对比度深色主题', 'High-contrast dark theme')}
          />
        </ModalSettingRow>
        <ModalSettingRow
          label={text('界面字体', 'Interface font')}
          description={text('用于菜单、侧栏和聊天等界面区域的字体。', 'Font for the interface — menus, sidebar, and chat.')}
        >
          <ModalSegmented
            value={interfaceFont}
            ariaLabel={text('界面字体', 'Interface font')}
            onChange={handleInterfaceFontChange}
            options={[
              { value: 'anthropic', label: 'Anthropic Sans' },
              { value: 'system', label: t('general.system') },
            ]}
          />
        </ModalSettingRow>
        <ModalSettingRow
          label={text('对话文字大小', 'Transcript text size')}
          description={text('对话正文的文字大小。', 'Size of the conversation transcript text.')}
        >
          <ModalSegmented
            value={markdownFontSize}
            ariaLabel={text('对话文字大小', 'Transcript text size')}
            onChange={handleFontSizeChange}
            options={[
              { value: 'small', label: text('小', 'Small') },
              { value: 'medium', label: text('中', 'Medium') },
              { value: 'large', label: text('大', 'Large') },
            ]}
          />
        </ModalSettingRow>
        <ModalSettingRow
          label={text('对话宽度', 'Transcript width')}
          description={text('对话正文与输入区的最大宽度。', 'Maximum width of the transcript and composer columns.')}
        >
          <ModalSegmented
            value={prefs.transcriptWidth}
            ariaLabel={text('对话宽度', 'Transcript width')}
            onChange={(value) => updatePref('transcriptWidth', value)}
            options={[
              { value: 'narrow', label: text('窄', 'Narrow') },
              { value: 'medium', label: text('中', 'Medium') },
              { value: 'wide', label: text('宽', 'Wide') },
            ]}
          />
        </ModalSettingRow>
      </div>

      <h2 className="mt-8 text-[15px] font-semibold text-foreground">{text('本地会话', 'Local sessions')}</h2>
      <div className="mt-1 divide-y divide-border/60">
        <ModalSettingRow
          label={text('允许绕过权限模式', 'Allow bypass permissions mode')}
          description={text('绕过所有权限检查，让 Agent 不间断工作，适用于修复格式错误或生成模板代码等流程。', 'Bypass all permission checks and let the agent work uninterrupted. Useful for workflows like fixing lint errors or generating boilerplate code.')}
        >
          <ModalSwitch
            checked={prefs.allowBypassPermissionsMode}
            onCheckedChange={(checked) => updatePref('allowBypassPermissionsMode', checked)}
            ariaLabel={text('允许绕过权限模式', 'Allow bypass permissions mode')}
          />
        </ModalSettingRow>
        <ModalSettingRow
          label={text('动态工作流', 'Dynamic workflows')}
          description={text('允许 Agent 并行运行多个子 Agent 处理复杂任务，可能会快速消耗用量。', 'Let the agent run multiple agents in parallel for complex tasks. Workflows can use a lot of your usage limit quickly.')}
        >
          <ModalSwitch
            checked={prefs.dynamicWorkflowsEnabled}
            onCheckedChange={(checked) => updatePref('dynamicWorkflowsEnabled', checked)}
            ariaLabel={text('动态工作流', 'Dynamic workflows')}
          />
        </ModalSettingRow>
        <ModalSettingRow
          label={text('通知时引起注意', 'Draw attention on notifications')}
          description={text('应用未聚焦且 Agent 需要你处理时弹跳 Dock 图标。', "Bounce the Dock icon when the agent needs your attention and the app isn't focused.")}
        >
          <ModalSwitch
            checked={prefs.drawAttentionOnNotifications}
            onCheckedChange={(checked) => updatePref('drawAttentionOnNotifications', checked)}
            ariaLabel={text('通知时引起注意', 'Draw attention on notifications')}
          />
        </ModalSettingRow>
        <ModalSettingRow
          label={text('工作时保持电脑唤醒', 'Keep computer awake while working')}
          description={text('代码会话运行时阻止电脑休眠，让长任务能够完成。', 'Prevent your computer from sleeping while a Code session is running, so long tasks can finish.')}
        >
          <ModalSwitch
            checked={prefs.keepAwakeWhileWorking}
            onCheckedChange={(checked) => updatePref('keepAwakeWhileWorking', checked)}
            ariaLabel={text('工作时保持电脑唤醒', 'Keep computer awake while working')}
          />
        </ModalSettingRow>
        <ModalSettingRow
          label={text('使用电池时也保持唤醒', 'Keep awake on battery power')}
          description={text('使用电池供电时也阻止电脑休眠。', 'Also prevent sleep when running on battery.')}
        >
          <ModalSwitch
            checked={prefs.keepAwakeOnBattery}
            onCheckedChange={(checked) => updatePref('keepAwakeOnBattery', checked)}
            ariaLabel={text('使用电池时也保持唤醒', 'Keep awake on battery power')}
          />
        </ModalSettingRow>
        <ModalSettingRow
          label={text('归档不活跃会话', 'Archive inactive sessions')}
          description={text('本地会话一段时间没有活动后自动归档。', 'Automatically archive local sessions after a period of no activity.')}
        >
          <ModalSelect
            value={prefs.archiveAfterDays === 0 ? 'never' : prefs.archiveAfterDays >= 30 ? '30d' : '7d'}
            ariaLabel={text('归档不活跃会话', 'Archive inactive sessions')}
            onChange={(value) => updatePref('archiveAfterDays', value === 'never' ? 0 : value === '30d' ? 30 : 7)}
            options={[
              { value: 'never', label: text('永不', 'Never') },
              { value: '7d', label: text('7 天', '7 days') },
              { value: '30d', label: text('30 天', '30 days') },
            ]}
          />
        </ModalSettingRow>
        <ModalSettingRow
          label={text('Worktree 位置', 'Worktree location')}
          description={text('用于隔离代码会话的 Git worktree 存储位置。', 'Where to store Git worktrees for isolated coding sessions.')}
        >
          <ModalSelect
            value={prefs.worktreeLocation}
            ariaLabel={text('Worktree 位置', 'Worktree location')}
            onChange={(value) => updatePref('worktreeLocation', value)}
            options={[
              { value: 'inside-project', label: text('项目内', 'Inside project') },
              { value: 'global', label: text('全局目录', 'Global directory') },
            ]}
          />
        </ModalSettingRow>
        <ModalSettingRow
          label={text('输出风格', 'Output style')}
          description={text('Agent 在代码会话中组织回复的方式，对新会话生效。', 'How the agent structures its responses in Code sessions. Applies to new sessions.')}
        >
          <ModalSelect
            value={prefs.outputStyle}
            ariaLabel={text('输出风格', 'Output style')}
            onChange={(value) => updatePref('outputStyle', value)}
            options={[
              { value: 'default', label: text('默认', 'Default') },
              { value: 'concise', label: text('简洁', 'Concise') },
              { value: 'detailed', label: text('详细', 'Detailed') },
            ]}
          />
        </ModalSettingRow>
      </div>

      <h2 className="mt-8 text-[15px] font-semibold text-foreground">{text('本地沙箱', 'Local sandbox')}</h2>
      <div className="mt-1 divide-y divide-border/60">
        <ModalSettingRow
          label={text('本地沙箱', 'Local sandbox')}
          description={text('在隔离沙箱中运行 Agent 命令，对新会话生效。', 'Run commands from the agent in an isolated sandbox. Takes effect for new sessions.')}
        >
          <ModalSwitch
            checked={prefs.localSandboxEnabled}
            onCheckedChange={(checked) => updatePref('localSandboxEnabled', checked)}
            ariaLabel={text('本地沙箱', 'Local sandbox')}
          />
        </ModalSettingRow>
        <ModalSettingRow
          label={text('严格沙箱模式', 'Strict sandbox mode')}
          description={text('直接阻止无法在沙箱内运行的命令，不在沙箱外运行，也不再询问。', "Block commands that can't run inside the sandbox instead of running them outside it or asking you.")}
        >
          <ModalSwitch
            checked={prefs.strictSandboxMode}
            onCheckedChange={(checked) => updatePref('strictSandboxMode', checked)}
            ariaLabel={text('严格沙箱模式', 'Strict sandbox mode')}
          />
        </ModalSettingRow>
      </div>
    </div>
  )
}

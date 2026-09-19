/**
 * LanguageDialog - 语言选择弹窗（对齐参考「Choose your language」）
 *
 * 只保留中文与英文两个卡片；选择后通过 Jotai 语言状态即时更新整个界面。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { languageDialogOpenAtom } from '@/atoms/settings-tab'
import {
  settingsPreferencesAtom,
  updateInterfaceLanguage,
} from '@/atoms/settings-preferences'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n'

const LANGUAGE_OPTIONS = [
  { value: 'zh' as const, name: '中文（简体）', subtitle: 'Chinese (Simplified)' },
  { value: 'en' as const, name: 'English (United States)', subtitle: 'English (United States)' },
]

export function LanguageDialog(): React.ReactElement {
  const [open, setOpen] = useAtom(languageDialogOpenAtom)
  const prefs = useAtomValue(settingsPreferencesAtom)
  const setPrefs = useSetAtom(settingsPreferencesAtom)
  const { t } = useTranslation()
  const [isSaving, setIsSaving] = React.useState(false)

  const handleSelect = async (value: 'zh' | 'en'): Promise<void> => {
    if (isSaving) return
    if (value === prefs.interfaceLanguage) {
      setOpen(false)
      return
    }
    setIsSaving(true)
    try {
      const saved = await updateInterfaceLanguage(value, prefs.interfaceLanguage, setPrefs)
      if (saved) setOpen(false)
      else toast.error(t('language.saveFailed'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="w-[420px] max-w-[92vw] rounded-xl p-6" data-language-dialog>
        <DialogTitle className="text-[17px] font-semibold text-foreground">
          {t('language.title')}
        </DialogTitle>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {LANGUAGE_OPTIONS.map((option) => {
            const selected = prefs.interfaceLanguage === option.value
            return (
              <button
                key={option.value}
                type="button"
                disabled={isSaving}
                onClick={() => { void handleSelect(option.value) }}
                aria-pressed={selected}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-lg border px-3.5 py-3 text-left transition-colors disabled:cursor-wait disabled:opacity-60',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45',
                  selected
                    ? 'border-foreground/30 bg-foreground/[0.06]'
                    : 'border-border/70 hover:bg-foreground/[0.04]',
                )}
              >
                <span className="flex w-full items-center justify-between gap-2 text-[14px] font-medium text-foreground">
                  {option.name}
                  {selected && <Check className="size-4 shrink-0 text-blue-500" />}
                </span>
                <span className="text-[12px] text-muted-foreground">{option.subtitle}</span>
              </button>
            )
          })}
        </div>
        <p className="mt-4 text-[12px] leading-5 text-muted-foreground/80">
          {t('language.description')}
        </p>
      </DialogContent>
    </Dialog>
  )
}

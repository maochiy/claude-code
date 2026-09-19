/**
 * SettingsModal - 设置模态框（图 8）
 *
 * 覆盖整个窗口的居中模态框：遮罩 bg-black/40，内容 952×711 圆角卡片，
 * 左侧 191px 导航 + 右侧页面区。所有旧的设置入口（settingsOpenAtom）
 * 都路由到这里，不再切换主视图。
 *
 * 渠道表单有未保存内容时，关闭 / 切页 / Cmd+W 都会弹出确认对话框。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  channelFormDirtyAtom,
  normalizeSettingsTab,
  settingsCloseRequestedAtom,
  settingsOpenAtom,
  settingsTabAtom,
} from '@/atoms/settings-tab'
import type { SettingsModalTab, SettingsTab } from '@/atoms/settings-tab'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SettingsModalNav } from './SettingsModalNav'
import { GeneralPage } from './GeneralPage'
import { ClaudeCodePage } from './ClaudeCodePage'
import { SkillsPage } from './SkillsPage'
import { UsagePage } from './UsagePage'
import { PlaceholderPage } from './PlaceholderPage'
import { ChannelSettings } from '../ChannelSettings'
import { GeneralSettings } from '../GeneralSettings'
import { AboutSettings } from '../AboutSettings'
import { ToolSettings } from '../ToolSettings'
import { ProfileSettings } from '../ProfileSettings'
import { PromptSettings } from '../PromptSettings'
import { ProxySettings } from '../ProxySettings'
import { BotHubSettings } from '../BotHubSettings'
import { ShortcutSettings } from '../ShortcutSettings'
import { VoiceInputSettings } from '../VoiceInputSettings'
import { MigrationSettings } from '../MigrationSettings'
import { StorageSettings } from '../StorageSettings'
import { ArchivedChatsSettings } from '../ArchivedChatsSettings'
import { useTranslation } from '@/lib/i18n'

function ComingSoonPage({ page }: { page: 'privacy' | 'cowork' | 'import-export' }): React.ReactElement {
  const { t } = useTranslation()
  if (page === 'privacy') {
    return <PlaceholderPage title={t('settings.nav.privacy')} description={t('settings.comingSoon.privacy')} />
  }
  if (page === 'cowork') {
    return <PlaceholderPage title={t('settings.nav.cowork')} description={t('settings.comingSoon.cowork')} />
  }
  return <PlaceholderPage title={t('settings.nav.importExport')} description={t('settings.comingSoon.importExport')} />
}

/** 待确认动作：切页或关闭 */
type PendingAction =
  | { type: 'tab'; tab: SettingsModalTab }
  | { type: 'close' }
  | null

/** 根据导航页渲染页面内容（含旧深链 ID 兼容） */
export function renderSettingsPage(tab: SettingsTab): React.ReactElement {
  switch (tab) {
    case 'settings-general':
      return <GeneralPage />
    case 'privacy':
      return <ComingSoonPage page="privacy" />
    case 'usage':
      return <UsagePage />
    case 'claude-code':
      return <ClaudeCodePage />
    case 'cowork':
      return <ComingSoonPage page="cowork" />
    case 'import-export':
      return <ComingSoonPage page="import-export" />
    case 'skills':
      return <SkillsPage />
    case 'desktop-general':
      return <GeneralSettings />
    case 'desktop-developer':
      return <AboutSettings />
    case 'connectors':
      return <ChannelSettings />
    case 'plugins':
      return <ToolSettings />
    // ===== 旧深链未映射到新导航的页面，原样保留功能 =====
    case 'profile':
      return <ProfileSettings />
    case 'prompts':
      return <PromptSettings />
    case 'proxy':
      return <ProxySettings />
    case 'bots':
      return <BotHubSettings />
    case 'shortcuts':
      return <ShortcutSettings />
    case 'voice-input':
      return <VoiceInputSettings />
    case 'migration':
      return <MigrationSettings />
    case 'storage':
      return <StorageSettings />
    case 'archived-chats':
      return <ArchivedChatsSettings />
    default:
      return <GeneralPage />
  }
}

export function SettingsModal(): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useAtom(settingsOpenAtom)
  const rawTab = useAtomValue(settingsTabAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const channelFormDirty = useAtomValue(channelFormDirtyAtom)
  const [closeRequested, setCloseRequested] = useAtom(settingsCloseRequestedAtom)
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null)

  // 渠道表单脏检查：旧深链 'channels' 归一化后同样拦截
  const activeTab = normalizeSettingsTab(rawTab)
  const guardClose = activeTab === 'connectors' && channelFormDirty

  const requestClose = React.useCallback((): void => {
    if (guardClose) {
      setPendingAction({ type: 'close' })
      return
    }
    setOpen(false)
  }, [guardClose, setOpen])

  // Cmd+W 等外部关闭请求
  React.useEffect(() => {
    if (!closeRequested) return
    if (guardClose) {
      setPendingAction({ type: 'close' })
    } else {
      setOpen(false)
    }
    setCloseRequested(false)
  }, [closeRequested, guardClose, setCloseRequested, setOpen])

  const handleNavigate = (tab: SettingsModalTab): void => {
    if (tab === activeTab) return
    if (guardClose) {
      setPendingAction({ type: 'tab', tab })
      return
    }
    setSettingsTab(tab)
  }

  const executePendingAction = (): void => {
    if (pendingAction === null) return
    if (pendingAction.type === 'tab') {
      setSettingsTab(pendingAction.tab)
    } else {
      setOpen(false)
    }
    setPendingAction(null)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next) requestClose() }}>
        <DialogContent
          hideClose
          className="flex h-[711px] max-h-[92vh] w-[952px] max-w-[94vw] translate-x-[-50%] translate-y-[-50%] flex-row gap-0 overflow-hidden rounded-[10px] p-0 shadow-[0_24px_80px_rgba(0,0,0,0.28)]"
          onEscapeKeyDown={(event) => {
            // 交给 onOpenChange(false) 统一走脏检查，仅阻止 Radix 默认立即关闭
            event.preventDefault()
            requestClose()
          }}
          data-settings-modal
        >
          <DialogTitle className="sr-only">{t('common.settings')}</DialogTitle>
          <SettingsModalNav
            activeTab={activeTab}
            onNavigate={handleNavigate}
          />
          <section className="relative flex min-w-0 flex-1 flex-col bg-background">
            <button
              type="button"
              onClick={requestClose}
              aria-label={t('settings.close')}
              data-settings-modal-close
              className="absolute right-4 top-4 z-10 rounded-md p-1 text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
            <ScrollArea className="min-h-0 min-w-0 flex-1">
              {renderSettingsPage(activeTab)}
            </ScrollArea>
          </section>
        </DialogContent>
      </Dialog>

      {/* 退出拦截弹窗（关闭 / 切页 / Cmd+W 共用） */}
      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(next) => { if (!next) setPendingAction(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.unsaved.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.unsaved.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingAction(null)}>{t('settings.unsaved.stay')}</AlertDialogCancel>
            <AlertDialogAction onClick={executePendingAction}>{t('settings.unsaved.leave')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

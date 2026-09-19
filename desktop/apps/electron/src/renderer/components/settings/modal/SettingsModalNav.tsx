/**
 * SettingsModalNav - 设置模态框左侧导航（对齐参考截图）
 *
 * 191px 侧栏：Search 搜索框 + 三个分组（Settings / Desktop app / Customize）。
 * 搜索按条目名称过滤。
 */

import * as React from 'react'
import {
  BarChart3,
  Code2,
  Monitor,
  Plug,
  Puzzle,
  Search,
  Settings,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SettingsModalTab, SettingsTab } from '@/atoms/settings-tab'
import { useTranslation, type TranslationKey } from '@/lib/i18n'

interface SettingsModalNavProps {
  /** 当前激活页；可能为旧深链 ID（此时分组无高亮项） */
  activeTab: SettingsTab
  onNavigate: (tab: SettingsModalTab) => void
}

interface NavItem {
  tab: SettingsModalTab
  labelKey: TranslationKey
  icon?: React.ReactNode
}

/** Settings 分组（通用、用量、Code） */
const SETTINGS_GROUP: NavItem[] = [
  { tab: 'settings-general', labelKey: 'settings.nav.general', icon: <Settings size={16} strokeWidth={1.75} /> },
  { tab: 'usage', labelKey: 'settings.nav.usage', icon: <BarChart3 size={16} strokeWidth={1.75} /> },
  { tab: 'claude-code', labelKey: 'settings.nav.claudeCode', icon: <Code2 size={16} strokeWidth={1.75} /> },
]

/** Desktop app 分组 */
const DESKTOP_GROUP: NavItem[] = [
  { tab: 'desktop-general', labelKey: 'settings.nav.general', icon: <Monitor size={16} strokeWidth={1.75} /> },
  { tab: 'desktop-developer', labelKey: 'settings.nav.developer', icon: <Wrench size={16} strokeWidth={1.75} /> },
]

/** Customize 分组 */
const CUSTOMIZE_GROUP: NavItem[] = [
  { tab: 'skills', labelKey: 'settings.nav.skills', icon: <Puzzle size={16} strokeWidth={1.75} /> },
  { tab: 'connectors', labelKey: 'settings.nav.connectors', icon: <Plug size={16} strokeWidth={1.75} /> },
]

function NavItemButton({ item, label, active, onClick }: {
  item: NavItem
  label: string
  active: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      data-settings-nav-item={item.tab}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45',
        active
          ? 'bg-foreground/[0.08] font-medium text-foreground'
          : 'text-foreground/75 hover:bg-foreground/[0.05] hover:text-foreground',
      )}
    >
      {item.icon !== undefined && (
        <span className="flex size-4 items-center justify-center text-foreground/70">{item.icon}</span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

export function SettingsModalNav({ activeTab, onNavigate }: SettingsModalNavProps): React.ReactElement {
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = React.useState('')
  const query = searchQuery.trim().toLocaleLowerCase()

  const match = (item: NavItem): boolean => query === '' || t(item.labelKey).toLocaleLowerCase().includes(query)
  const settingsItems = SETTINGS_GROUP.filter(match)
  const desktopItems = DESKTOP_GROUP.filter(match)
  const customizeItems = CUSTOMIZE_GROUP.filter(match)

  return (
    <aside className="flex w-[191px] shrink-0 flex-col bg-sidebar-surface" data-settings-modal-nav>
      <div className="px-2 pt-3">
        <div className="flex h-[31px] items-center gap-1.5 rounded-lg border border-border/70 bg-background px-2.5 text-muted-foreground focus-within:border-foreground/25">
          <Search size={13} className="shrink-0" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('common.search')}
            aria-label={t('settings.search')}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
          />
        </div>
      </div>

      <nav aria-label={t('common.settings')} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3 pt-3">
        {settingsItems.length > 0 && (
          <div className="px-2 pb-1 pt-1 text-[13px] text-muted-foreground">{t('settings.group.settings')}</div>
        )}
        {settingsItems.map((item) => (
          <NavItemButton key={item.tab} item={item} label={t(item.labelKey)} active={activeTab === item.tab} onClick={() => onNavigate(item.tab)} />
        ))}

        {desktopItems.length > 0 && (
          <div className="px-2 pb-1 pt-4 text-[13px] text-muted-foreground">{t('settings.group.desktop')}</div>
        )}
        {desktopItems.map((item) => (
          <NavItemButton key={item.tab} item={item} label={t(item.labelKey)} active={activeTab === item.tab} onClick={() => onNavigate(item.tab)} />
        ))}

        {customizeItems.length > 0 && (
          <div className="px-2 pb-1 pt-4 text-[13px] text-muted-foreground">{t('settings.group.customize')}</div>
        )}
        {customizeItems.map((item) => (
          <NavItemButton key={item.tab} item={item} label={t(item.labelKey)} active={activeTab === item.tab} onClick={() => onNavigate(item.tab)} />
        ))}

        {settingsItems.length === 0 && desktopItems.length === 0 && customizeItems.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">{t('settings.noMatches')}</div>
        )}
      </nav>
    </aside>
  )
}

import { useAtom } from 'jotai'
import { ChevronRight, Clock, KanbanSquare } from 'lucide-react'
import { sidebarMoreExpandedAtom } from '@/atoms/sidebar-atoms'
import { useTranslation } from '@/lib/i18n'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

interface SidebarMoreMenuProps {
  onOpenTaskboard: () => void
  onOpenAutomations: () => void
}

/** 侧栏更多菜单的固定入口；保持轻量，不承载设置或项目内联内容。 */
export const SIDEBAR_MORE_ITEM_IDS = ['taskboard', 'automations'] as const

/** 更多入口在右侧展开紧凑菜单，不挤压下方项目列表。 */
export function SidebarMoreMenu({ onOpenTaskboard, onOpenAutomations }: SidebarMoreMenuProps): React.ReactElement {
  const [open, setOpen] = useAtom(sidebarMoreExpandedAtom)
  const { t } = useTranslation()
  const actions = {
    taskboard: onOpenTaskboard,
    automations: onOpenAutomations,
  }
  const items = {
    taskboard: { icon: KanbanSquare, label: t('sidebar.taskboard') },
    automations: { icon: Clock, label: t('sidebar.automations') },
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-foreground/[0.045] data-[state=open]:bg-foreground/[0.045] titlebar-no-drag">
          <ChevronRight size={14} className="mx-0.5 transition-transform group-data-[state=open]:rotate-90" />
          <span>{t('common.more')}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" sideOffset={4} className="w-36 rounded-xl">
        {SIDEBAR_MORE_ITEM_IDS.map((id) => {
          const Icon = items[id].icon
          return (
            <DropdownMenuItem key={id} onSelect={actions[id]} className="gap-2 text-[13px]">
              <Icon size={14} />{items[id].label}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

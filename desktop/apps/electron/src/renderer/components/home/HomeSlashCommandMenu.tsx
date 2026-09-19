import * as React from 'react'
import { Terminal } from 'lucide-react'
import type { AgentWorkspace, LocalCliSlashCommand } from '@proma/shared'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n'

/** 主页只在整段输入仍是一个 slash token 时展示原生命令。 */
export function getHomeSlashQuery(value: string): string | null {
  const match = /^\/([^\s]*)$/.exec(value)
  return match ? match[1]!.toLowerCase() : null
}

/** 初始化尚未恢复显式选择时，沿用工作区列表的默认首项。 */
export function resolveHomeCommandCatalogWorkspaceId(
  currentWorkspaceId: string | null,
  workspaces: readonly AgentWorkspace[],
): string | null {
  return currentWorkspaceId ?? workspaces[0]?.id ?? null
}

export function filterHomeSlashCommands(
  commands: readonly LocalCliSlashCommand[],
  query: string,
): LocalCliSlashCommand[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return [...commands]
  return commands.filter((command) => {
    const name = command.name.replace(/^\/+/, '').toLowerCase()
    return name.includes(normalizedQuery)
      || command.description.toLowerCase().includes(normalizedQuery)
  })
}

interface HomeSlashCommandMenuProps {
  commands: readonly LocalCliSlashCommand[]
  loading: boolean
  selectedIndex: number
  onSelect: (command: LocalCliSlashCommand) => void
}

export function HomeSlashCommandMenu({
  commands,
  loading,
  selectedIndex,
  onSelect,
}: HomeSlashCommandMenuProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      className="absolute bottom-full left-0 z-30 mb-2 w-[320px] max-w-full overflow-hidden rounded-lg border bg-popover shadow-lg"
      data-home-slash-command-menu
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-primary/10 px-2.5 py-1.5 text-[11px] font-medium text-primary">
        <span>{t('slash.header')}</span>
        <span className="font-normal text-muted-foreground">{t('mention.keyboardHint')}</span>
      </div>
      {commands.length === 0 ? (
        <div className="p-2 text-[11px] text-muted-foreground">
          {loading ? '…' : t('slash.empty')}
        </div>
      ) : (
        <div className="max-h-[240px] overflow-y-auto">
          {commands.map((command, index) => {
            const name = command.name.replace(/^\/+/, '')
            return (
              <button
                key={name}
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent',
                  index === selectedIndex && 'bg-accent text-accent-foreground',
                )}
                onMouseDown={(event) => {
                  event.preventDefault()
                  onSelect(command)
                }}
              >
                <Terminal className="size-3.5 shrink-0 text-sky-500" />
                <span className="min-w-0 flex-1 truncate font-medium">/{name}</span>
                <span className="max-w-[155px] truncate text-[10px] text-muted-foreground/60">
                  {command.description || command.argumentHint}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

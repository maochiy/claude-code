import * as React from 'react'
import { Check, FilePlus2, Folder, Lightbulb, Mic, Plus, Blocks, SquareSlash } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { startVoiceDictation } from '@/components/ai-elements/speech-button'
import { useTranslation } from '@/lib/i18n'

interface AgentInputAddMenuProps {
  onAttachFile: () => void
  onAttachFolder?: () => void
  onOpenSkills?: () => void
  onOpenConnectors?: () => void
  planModeEnabled?: boolean
  onPlanModeChange?: (enabled: boolean) => void
}

interface AddMenuItemProps {
  icon: React.ReactNode
  label: string
  description?: string
  onClick: () => void
  selected?: boolean
}

function AddMenuItem({
  icon,
  label,
  description,
  onClick,
  selected = false,
}: AddMenuItemProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
        'transition-colors hover:bg-accent/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-foreground/70">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-foreground">{label}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </span>
      {selected && <Check className="size-4 shrink-0 text-foreground/60" />}
    </button>
  )
}

export function AgentInputAddMenu({
  onAttachFile,
  onAttachFolder,
  onOpenSkills,
  onOpenConnectors,
  planModeEnabled,
  onPlanModeChange,
}: AgentInputAddMenuProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  const runAction = (action: () => void): void => {
    setOpen(false)
    requestAnimationFrame(action)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('agent.addContent')}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/60',
            'transition-colors hover:bg-muted/55 hover:text-foreground',
            'data-[state=open]:bg-muted/55 data-[state=open]:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <Plus className="size-[18px]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[220px] rounded-xl p-1"
        onOpenAutoFocus={event => event.preventDefault()}
      >
        <AddMenuItem
          icon={<FilePlus2 className="size-4" />}
          label={t('agent.addFile')}
          onClick={() => runAction(onAttachFile)}
        />
        {onAttachFolder && (
          <AddMenuItem
            icon={<Folder className="size-4" />}
            label={t('agent.addFolder')}
            onClick={() => runAction(onAttachFolder)}
          />
        )}
        {onOpenSkills && (
          <AddMenuItem
            icon={<SquareSlash className="size-4" />}
            label={t('agent.skillsCommands')}
            onClick={() => runAction(onOpenSkills)}
          />
        )}
        {onOpenConnectors && (
          <AddMenuItem
            icon={<Blocks className="size-4" />}
            label={t('agent.addConnector')}
            onClick={() => runAction(onOpenConnectors)}
          />
        )}
        {onPlanModeChange && (
          <AddMenuItem
            icon={<Lightbulb className="size-4" />}
            label={t('agent.plan')}
            selected={planModeEnabled}
            onClick={() => runAction(() => onPlanModeChange(!planModeEnabled))}
          />
        )}
        <AddMenuItem
          icon={<Mic className="size-4" />}
          label={t('agent.voiceInput')}
          onClick={() => runAction(() => { void startVoiceDictation() })}
        />
      </PopoverContent>
    </Popover>
  )
}

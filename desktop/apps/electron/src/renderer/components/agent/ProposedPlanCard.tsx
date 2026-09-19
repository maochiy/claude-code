import * as React from 'react'
import {
  CheckCircle2,
  ChevronRight,
  CircleX,
  FileText,
  MessageSquareWarning,
} from 'lucide-react'
import { useSetAtom } from 'jotai'
import { MessageResponse } from '@/components/ai-elements/message'
import { publishPlanDocumentAtom } from '@/atoms/plan-document'
import { useTranslation } from '@/lib/i18n'
import type { PlanDocumentStage } from '@/lib/plan-document'
import { cn } from '@/lib/utils'

interface ProposedPlanCardProps {
  content: string
  documentId: string
  sessionId?: string
  streaming?: boolean
  stage?: PlanDocumentStage
}

interface PlanStagePresentation {
  labelKey: 'plan.document' | 'plan.proposed' | 'plan.approved' | 'plan.changesRequested' | 'plan.rejected'
  icon: React.ComponentType<{ className?: string }>
  className: string
}

const PLAN_STAGE_PRESENTATION: Record<PlanDocumentStage, PlanStagePresentation> = {
  document: {
    labelKey: 'plan.document',
    icon: FileText,
    className: 'text-muted-foreground',
  },
  proposed: {
    labelKey: 'plan.proposed',
    icon: FileText,
    className: 'text-primary',
  },
  approved: {
    labelKey: 'plan.approved',
    icon: CheckCircle2,
    className: 'text-emerald-600 dark:text-emerald-400',
  },
  changes_requested: {
    labelKey: 'plan.changesRequested',
    icon: MessageSquareWarning,
    className: 'text-amber-600 dark:text-amber-400',
  },
  rejected: {
    labelKey: 'plan.rejected',
    icon: CircleX,
    className: 'text-destructive',
  },
}

/** 消息保留阶段明确的入口；已批准的历史计划同时允许就地展开原文。 */
export function ProposedPlanCard({
  content,
  documentId,
  sessionId,
  streaming = false,
  stage = 'document',
}: ProposedPlanCardProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const publish = useSetAtom(publishPlanDocumentAtom)
  const { t } = useTranslation()
  const presentation = PLAN_STAGE_PRESENTATION[stage]
  const StageIcon = presentation.icon
  const canExpandInline = stage === 'approved' || !sessionId

  const openPanel = (): void => {
    if (!sessionId) {
      setExpanded((value) => !value)
      return
    }
    publish({ sessionId, document: { id: documentId, content }, select: true })
  }

  return (
    <div data-proposed-plan data-plan-stage={stage} className="py-0.5">
      <button
        type="button"
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md py-1 text-[13px] font-medium hover:opacity-80',
          presentation.className,
          streaming && 'agent-status-shimmer',
        )}
        aria-label={canExpandInline ? t('plan.toggle') : t('plan.open')}
        aria-expanded={canExpandInline ? expanded : undefined}
        onClick={() => canExpandInline ? setExpanded((value) => !value) : openPanel()}
      >
        <StageIcon className="size-3.5" />
        {t(streaming ? 'plan.writing' : presentation.labelKey)}
        <ChevronRight className={cn('size-3.5', expanded && 'rotate-90')} />
      </button>
      {sessionId && (
        <button
          type="button"
          className="ml-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={openPanel}
        >
          {t('plan.viewFull')}
        </button>
      )}
      {canExpandInline && expanded && (
        <div className="mt-1 rounded-xl bg-muted/30 px-3 py-2" data-plan-inline-content>
          <MessageResponse>{content}</MessageResponse>
        </div>
      )}
    </div>
  )
}

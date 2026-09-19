import { selectedPlanDocumentAtomFamily } from '@/atoms/plan-document'
import { MessageResponse } from '@/components/ai-elements/message'
import { useTranslation } from '@/lib/i18n'
import * as React from 'react'
import { useAtomValue } from 'jotai'
import {
  agentRuntimeExecutionGraphAtomFamily,
  agentRuntimePlanLifecycleAtom,
  agentSessionStreamingStateAtomFamily,
  agentSidePanelRuntimeHistoryAtom,
} from '@/atoms/agent-atoms'
import { sortRuntimeTodos } from './RuntimeTodoHoverProgress'
import { RuntimePlanList } from './RuntimePlanList'
import { getVisibleRuntimePlanTodos } from '@/lib/runtime-plan-lifecycle'
import type { PlanDocument } from '@/lib/plan-document'
import { Copy, FileSearch, Maximize2, Minimize2 } from 'lucide-react'
import { toast } from 'sonner'

export interface RuntimePlanToolbarProps {
  document?: PlanDocument
  expanded: boolean
  onToggleExpanded?: () => void
  onOpenSource?: (sourcePath: string) => void
}

/** 计划面板头部动作。源文件按钮只接受 Runtime 明确提供的真实路径。 */
export function RuntimePlanToolbar({
  document,
  expanded,
  onToggleExpanded,
  onOpenSource,
}: RuntimePlanToolbarProps): React.ReactElement {
  const { t } = useTranslation()
  const handleCopy = React.useCallback(() => {
    if (!document) return
    void navigator.clipboard.writeText(document.content)
      .then(() => toast.success(t('plan.copied')))
      .catch(() => toast.error(t('plan.copyFailed')))
  }, [document, t])

  return (
    <div className="titlebar-no-drag relative flex items-center gap-0.5" data-plan-toolbar>
      {document && (
        <button
          type="button"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
          aria-label={t('plan.copy')}
          title={t('plan.copy')}
          onClick={handleCopy}
        >
          <Copy className="size-3.5" />
        </button>
      )}
      {document?.sourcePath && onOpenSource && (
        <button
          type="button"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
          aria-label={t('plan.openSource')}
          title={document.sourcePath}
          onClick={() => onOpenSource(document.sourcePath!)}
        >
          <FileSearch className="size-3.5" />
        </button>
      )}
      {onToggleExpanded && (
        <button
          type="button"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
          aria-label={t(expanded ? 'sidePanel.restoreSize' : 'sidePanel.expandPane')}
          title={t(expanded ? 'sidePanel.restoreSize' : 'sidePanel.expandPane')}
          aria-pressed={expanded}
          onClick={onToggleExpanded}
        >
          {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
      )}
    </div>
  )
}

export function RuntimePlanPanel({
  sessionId,
}: {
  sessionId: string
}): React.ReactElement {
  const document = useAtomValue(selectedPlanDocumentAtomFamily(sessionId))
  const { t } = useTranslation()
  const graph = useAtomValue(agentRuntimeExecutionGraphAtomFamily(sessionId))
  const history = useAtomValue(agentSidePanelRuntimeHistoryAtom).get(sessionId)
  const planLifecycle = useAtomValue(agentRuntimePlanLifecycleAtom).get(sessionId)
  const running = useAtomValue(agentSessionStreamingStateAtomFamily(sessionId))
    ?.running === true
  const fallbackTodos = graph?.todos.length
    ? graph.todos
    : (history?.todos ?? [])
  const sourceTodos = getVisibleRuntimePlanTodos(
    planLifecycle,
    fallbackTodos,
  )
  const todos = React.useMemo(
    () => sortRuntimeTodos(sourceTodos),
    [sourceTodos],
  )

  return (
    <div
      className="scrollbar-none h-full min-h-0 overflow-y-auto px-5 py-3"
      data-runtime-plan-panel
    >
      {document ? (
        <article className="min-w-0 break-words [--md-preview-font-size:14px]" data-plan-document>
          <MessageResponse>{document.content}</MessageResponse>
        </article>
      ) : todos.length > 0 ? (
        <RuntimePlanList
          todos={todos}
          running={running}
          planActive={
            planLifecycle == null
            || planLifecycle.current?.status === 'active'
          }
        />
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
          {t('plan.empty')}
        </div>
      )}
    </div>
  )
}

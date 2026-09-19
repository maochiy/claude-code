import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import { currentAgentSessionIdAtom, openAgentSidePanelTabAtom } from './agent-atoms'
import type { PlanDocument } from '@/lib/plan-document'

interface SessionPlans {
  documents: Map<string, PlanDocument>
  selectedId: string
}

const sessionPlansAtom = atom(new Map<string, SessionPlans>())
export const selectedPlanDocumentAtomFamily = atomFamily((sessionId: string) => atom((get) => {
  const plans = get(sessionPlansAtom).get(sessionId)
  return plans?.documents.get(plans.selectedId)
}))

interface PublishPlanInput {
  sessionId: string
  document: PlanDocument
  /** 历史恢复只填充数据，不抢占面板或已选中的版本。 */
  autoOpen?: boolean
  select?: boolean
}

export const publishPlanDocumentAtom = atom(null, (get, set, input: PublishPlanInput) => {
  if (!input.document.content.trim()) return
  const sessions = get(sessionPlansAtom)
  const previous = sessions.get(input.sessionId)
  if (previous && !input.autoOpen && !input.select) return
  const known = previous?.documents.get(input.document.id)
  const firstLiveDocument = !known && input.autoOpen === true
  const selectedId = input.select || firstLiveDocument || !previous
    ? input.document.id : previous.selectedId
  if (
    known?.content !== input.document.content
    || known?.sourcePath !== input.document.sourcePath
    || previous?.selectedId !== selectedId
  ) {
    const documents = new Map(previous?.documents)
    documents.set(input.document.id, input.document)
    set(sessionPlansAtom, new Map(sessions).set(input.sessionId, { documents, selectedId }))
  }
  // 流式更新仅替换正文；关闭后不再次弹开，后台会话不抢焦点。
  if ((firstLiveDocument || input.select) && get(currentAgentSessionIdAtom) === input.sessionId) {
    set(openAgentSidePanelTabAtom, { sessionId: input.sessionId, tab: 'plan' })
  }
})

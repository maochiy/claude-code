import type { createStore } from 'jotai'
import type { AgentInteractionSettlement, AskUserRequest, ExitPlanModeRequest, PendingRequestsSnapshot, PermissionRequest } from '@proma/shared'
import {
  allPendingAskUserRequestsAtom,
  allPendingExitPlanRequestsAtom,
  allPendingPermissionRequestsAtom,
  askUserDraftsAtom,
} from '@/atoms/agent-atoms'

interface PendingRequestIdentity {
  requestId: string
  sessionId: string
}

type PendingInteractionEvent =
  | { type: 'interaction_settled'; settlement: AgentInteractionSettlement }
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'ask_user_request'; request: AskUserRequest }
  | { type: 'exit_plan_mode_request'; request: ExitPlanModeRequest }
  | { type: 'permission_resolved' | 'ask_user_resolved' | 'exit_plan_mode_resolved'; requestId: string }

function addRequest<T extends PendingRequestIdentity>(requests: Map<string, readonly T[]>, request: T): Map<string, readonly T[]> {
  const current = requests.get(request.sessionId) ?? []
  if (current.some((item) => item.requestId === request.requestId)) return requests
  return new Map(requests).set(request.sessionId, [...current, request])
}

function removeRequest<T extends PendingRequestIdentity>(requests: Map<string, readonly T[]>, requestId: string): Map<string, readonly T[]> {
  const next = new Map(requests)
  let changed = false
  for (const [sessionId, items] of requests) {
    const remaining = items.filter((request) => request.requestId !== requestId)
    if (remaining.length === items.length) continue
    changed = true
    if (remaining.length) next.set(sessionId, remaining)
    else next.delete(sessionId)
  }
  return changed ? next : requests
}

/** 主进程快照为准，但请求快照期间收到的实时事件不能被旧快照覆盖。 */
function reconcileRequests<T extends PendingRequestIdentity>(
  current: Map<string, readonly T[]>,
  snapshot: readonly T[],
  changedIds: ReadonlySet<string>,
): Map<string, readonly T[]> {
  let next = new Map<string, readonly T[]>()
  for (const request of snapshot) {
    if (!changedIds.has(request.requestId)) next = addRequest(next, request)
  }
  for (const requests of current.values()) {
    for (const request of requests) {
      if (changedIds.has(request.requestId)) next = addRequest(next, request)
    }
  }
  return next
}

/** 一个监听器生命周期内协调三类请求；先订阅事件再恢复快照，不重放通知。 */
export function createPendingInteractionSync(store: ReturnType<typeof createStore>) {
  const inFlightChanges = new Set<Set<string>>()
  let latestSnapshot = 0
  let disposed = false

  const receive = (event: PendingInteractionEvent): boolean => {
    if (disposed) return false
    if (event.type === 'interaction_settled') {
      const type = event.settlement.kind === 'permission' ? 'permission_resolved'
        : event.settlement.kind === 'ask_user' ? 'ask_user_resolved' : 'exit_plan_mode_resolved'
      return receive({ type, requestId: event.settlement.requestId })
    }
    const requestId = 'request' in event ? event.request.requestId : event.requestId
    for (const changes of inFlightChanges) changes.add(requestId)
    switch (event.type) {
      case 'permission_request': {
        const previous = store.get(allPendingPermissionRequestsAtom)
        const next = addRequest(previous, event.request)
        store.set(allPendingPermissionRequestsAtom, next)
        return previous !== next
      }
      case 'ask_user_request': {
        const previous = store.get(allPendingAskUserRequestsAtom)
        const next = addRequest(previous, event.request)
        store.set(allPendingAskUserRequestsAtom, next)
        return previous !== next
      }
      case 'exit_plan_mode_request': {
        const previous = store.get(allPendingExitPlanRequestsAtom)
        const next = addRequest(previous, event.request)
        store.set(allPendingExitPlanRequestsAtom, next)
        return previous !== next
      }
      case 'permission_resolved':
        store.set(allPendingPermissionRequestsAtom, (previous) => removeRequest(previous, requestId))
        break
      case 'ask_user_resolved':
        store.set(allPendingAskUserRequestsAtom, (previous) => removeRequest(previous, requestId))
        store.set(askUserDraftsAtom, (previous) => {
          if (!previous.has(requestId)) return previous
          const next = new Map(previous)
          next.delete(requestId)
          return next
        })
        break
      case 'exit_plan_mode_resolved':
        store.set(allPendingExitPlanRequestsAtom, (previous) => removeRequest(previous, requestId))
        break
    }
    return false
  }

  const restore = async (fetchSnapshot: () => Promise<PendingRequestsSnapshot>): Promise<void> => {
    if (disposed) return
    const ticket = ++latestSnapshot
    const changes = new Set<string>()
    inFlightChanges.add(changes)
    try {
      const snapshot = await fetchSnapshot()
      if (disposed || ticket !== latestSnapshot) return
      store.set(allPendingPermissionRequestsAtom, (previous) => reconcileRequests(previous, snapshot.permissions, changes))
      store.set(allPendingAskUserRequestsAtom, (previous) => reconcileRequests(previous, snapshot.askUsers, changes))
      store.set(allPendingExitPlanRequestsAtom, (previous) => reconcileRequests(previous, snapshot.exitPlans, changes))
      const pendingAskIds = new Set(Array.from(store.get(allPendingAskUserRequestsAtom).values()).flat().map((request) => request.requestId))
      store.set(askUserDraftsAtom, (previous) => new Map(Array.from(previous).filter(([id]) => pendingAskIds.has(id))))
    } finally {
      inFlightChanges.delete(changes)
    }
  }

  return { receive, restore, dispose: () => { disposed = true; inFlightChanges.clear() } }
}

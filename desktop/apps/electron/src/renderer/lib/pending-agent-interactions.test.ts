import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AskUserRequest, ExitPlanModeRequest, PendingRequestsSnapshot, PermissionRequest } from '@proma/shared'
import { allPendingAskUserRequestsAtom, allPendingExitPlanRequestsAtom, allPendingPermissionRequestsAtom } from '@/atoms/agent-atoms'
import { createPendingInteractionSync } from './pending-agent-interactions'

const permission: PermissionRequest = { requestId: 'p1', sessionId: 'a', toolName: 'Write', toolInput: {}, description: '写文件', dangerLevel: 'normal' }
const ask: AskUserRequest = { requestId: 'q1', sessionId: 'b', questions: [], toolInput: {} }
const plan: ExitPlanModeRequest = { requestId: 'e1', sessionId: 'a', toolInput: {}, allowedPrompts: [] }
const empty: PendingRequestsSnapshot = { permissions: [], askUsers: [], exitPlans: [] }

function deferredSnapshot() {
  let resolve!: (snapshot: PendingRequestsSnapshot) => void
  const promise = new Promise<PendingRequestsSnapshot>((done) => { resolve = done })
  return { promise, resolve }
}

describe('待处理交互快照协调', () => {
  test('Given 三类请求等待 When 收到取消结算 Then 只清除对应会话请求且不可被旧快照恢复', async () => {
    const store = createStore()
    const sync = createPendingInteractionSync(store)
    sync.receive({ type: 'permission_request', request: permission })
    sync.receive({ type: 'ask_user_request', request: ask })
    sync.receive({ type: 'exit_plan_mode_request', request: plan })
    const pending = deferredSnapshot()
    const restoring = sync.restore(() => pending.promise)
    sync.receive({ type: 'interaction_settled', settlement: {
      requestId: plan.requestId, sessionId: plan.sessionId, kind: 'exit_plan',
      outcome: 'cancelled', createdAt: 1, sequence: 1, settledAt: 2,
    } })
    pending.resolve({ permissions: [permission], askUsers: [ask], exitPlans: [plan] })
    await restoring
    expect(store.get(allPendingExitPlanRequestsAtom).size).toBe(0)
    expect(store.get(allPendingPermissionRequestsAtom).get('a')).toEqual([permission])
    expect(store.get(allPendingAskUserRequestsAtom).get('b')).toEqual([ask])
  })

  test('Given 界面重载 When 取得快照 Then 按会话恢复三类请求且不重复入队', async () => {
    const store = createStore()
    const sync = createPendingInteractionSync(store)
    await sync.restore(async () => ({ permissions: [permission, permission], askUsers: [ask], exitPlans: [plan] }))
    expect(store.get(allPendingPermissionRequestsAtom).get('a')).toEqual([permission])
    expect(store.get(allPendingAskUserRequestsAtom).get('b')).toEqual([ask])
    expect(store.get(allPendingExitPlanRequestsAtom).get('a')).toEqual([plan])
    expect(sync.receive({ type: 'permission_request', request: permission })).toBe(false)
  })

  test('Given 快照读取中 When 请求已在另一窗口结算 Then 旧快照不能复活审批', async () => {
    const store = createStore()
    const sync = createPendingInteractionSync(store)
    const pending = deferredSnapshot()
    const restoring = sync.restore(() => pending.promise)
    sync.receive({ type: 'permission_resolved', requestId: permission.requestId })
    pending.resolve({ ...empty, permissions: [permission] })
    await restoring
    expect(store.get(allPendingPermissionRequestsAtom).size).toBe(0)
  })

  test('Given 快照读取中 When 收到新的询问 Then 空快照不能丢弃实时请求', async () => {
    const store = createStore()
    const sync = createPendingInteractionSync(store)
    const pending = deferredSnapshot()
    const restoring = sync.restore(() => pending.promise)
    sync.receive({ type: 'ask_user_request', request: ask })
    pending.resolve(empty)
    await restoring
    expect(store.get(allPendingAskUserRequestsAtom).get('b')).toEqual([ask])
  })

  test('Given 权限和计划分别等待 When 收到对应resolved Then 只清除匹配请求', () => {
    const store = createStore()
    const sync = createPendingInteractionSync(store)
    sync.receive({ type: 'permission_request', request: permission })
    sync.receive({ type: 'exit_plan_mode_request', request: plan })
    sync.receive({ type: 'permission_resolved', requestId: 'unrelated' })
    expect(store.get(allPendingPermissionRequestsAtom).size).toBe(1)
    sync.receive({ type: 'permission_resolved', requestId: permission.requestId })
    expect(store.get(allPendingPermissionRequestsAtom).size).toBe(0)
    expect(store.get(allPendingExitPlanRequestsAtom).size).toBe(1)
    sync.receive({ type: 'exit_plan_mode_resolved', requestId: plan.requestId })
    expect(store.get(allPendingExitPlanRequestsAtom).size).toBe(0)
  })

  test('Given 焦点恢复触发两个快照 When 旧结果最后到达 Then 新快照优先并清理已失效请求', async () => {
    const store = createStore()
    const sync = createPendingInteractionSync(store)
    sync.receive({ type: 'permission_request', request: permission })
    const pending = deferredSnapshot()
    const restoring = sync.restore(() => pending.promise)
    await sync.restore(async () => empty)
    pending.resolve({ ...empty, permissions: [permission] })
    await restoring
    expect(store.get(allPendingPermissionRequestsAtom).size).toBe(0)
  })

  test('Given 请求正在展示 When 快照读取失败 Then 保留当前可响应请求', async () => {
    const store = createStore()
    const sync = createPendingInteractionSync(store)
    sync.receive({ type: 'ask_user_request', request: ask })
    await expect(sync.restore(async () => { throw new Error('离线') })).rejects.toThrow('离线')
    expect(store.get(allPendingAskUserRequestsAtom).get('b')).toEqual([ask])
  })

  test('Given 监听器已卸载 When 慢快照返回 Then 不修改新监听器的状态', async () => {
    const store = createStore()
    const sync = createPendingInteractionSync(store)
    const pending = deferredSnapshot()
    const restoring = sync.restore(() => pending.promise)
    sync.dispose()
    pending.resolve({ ...empty, permissions: [permission] })
    await restoring
    expect(store.get(allPendingPermissionRequestsAtom).size).toBe(0)
  })
})

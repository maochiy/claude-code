import * as React from 'react'
import { atom, useAtomValue, useStore } from 'jotai'
import { atomFamily } from 'jotai/utils'
import { normalizeAgentContextUsageBreakdown, type AgentContextUsageBreakdown } from '@/lib/agent-context-usage'

interface ContextSnapshot {
  breakdown?: AgentContextUsageBreakdown
  loading: boolean
  error?: string
  refreshedAt?: number
  revision: string
}
const contextAtomFamily = atomFamily((_sessionId: string) => atom<ContextSnapshot>({ loading: false, revision: '' }))

/** 只在边界和主动打开详情时读取；流式 token 更新不会触发上下文分析。 */
export function useLocalCliContext(input: {
  sessionId: string
  modelId?: string
  channelId?: string
  running: boolean
  compacting: boolean
}): {
  breakdown?: AgentContextUsageBreakdown
  loading: boolean
  error?: string
  refresh: () => Promise<void>
  setAutoCompact: (enabled: boolean) => Promise<void>
} {
  const { sessionId, modelId, channelId } = input
  const store = useStore()
  const snapshotAtom = contextAtomFamily(sessionId)
  const snapshot = useAtomValue(snapshotAtom)
  const revision = `${channelId ?? ''}:${modelId ?? ''}`
  const refresh = React.useCallback(async () => {
    const current = store.get(snapshotAtom)
    if (current.loading || !window.electronAPI.getLocalCliSessionContext) return
    store.set(snapshotAtom, { ...current, loading: true, error: undefined, revision })
    try {
      const raw = await window.electronAPI.getLocalCliSessionContext({
        sessionId,
        // 只有用户打开详情触发 refresh 时，才允许主进程准备 Runtime。
        prepareIfNeeded: true,
      })
      // 同一请求期间模型已切换时，不能用旧容量覆盖新模型。
      if (store.get(snapshotAtom).revision !== revision) return
      store.set(snapshotAtom, {
        breakdown: normalizeAgentContextUsageBreakdown(raw), loading: false,
        revision, refreshedAt: Date.now(),
      })
    } catch (error) {
      if (store.get(snapshotAtom).revision !== revision) return
      store.set(snapshotAtom, { ...store.get(snapshotAtom), loading: false,
        error: error instanceof Error ? error.message : String(error) })
    }
  }, [store, snapshotAtom, sessionId, revision])

  React.useEffect(() => {
    if (store.get(snapshotAtom).revision !== revision) {
      store.set(snapshotAtom, { loading: false, revision })
    }
    // 历史会话只显示 JSONL 中已经持久化的 contextStatus；这里不能自动
    // 调用 Runtime，否则仅打开一个旧会话也会启动 CLI 子进程。
  }, [store, snapshotAtom, revision])
  const setAutoCompact = React.useCallback(async (enabled: boolean) => {
    await window.electronAPI.setLocalCliSessionAutoCompact({ sessionId, enabled })
    await refresh()
  }, [sessionId, refresh])
  const isCurrentRevision = snapshot.revision === revision
  return {
    breakdown: isCurrentRevision ? snapshot.breakdown : undefined,
    loading: isCurrentRevision && snapshot.loading,
    error: isCurrentRevision ? snapshot.error : undefined,
    refresh,
    setAutoCompact,
  }
}

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type {
  AgentMessagePinsSnapshot,
  AgentMessagePinUpdateInput,
} from '@proma/shared'

export interface AgentMessagePinsState extends AgentMessagePinsSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
}

function createInitialState(sessionId: string): AgentMessagePinsState {
  return {
    sessionId,
    messageUuids: [],
    missingMessageUuids: [],
    status: 'idle',
  }
}

export const agentMessagePinsAtomFamily = atomFamily((sessionId: string) => (
  atom<AgentMessagePinsState>(createInitialState(sessionId))
))

export const loadAgentMessagePinsAtom = atom(
  null,
  async (get, set, input: { sessionId: string; force?: boolean }): Promise<AgentMessagePinsSnapshot | undefined> => {
    const target = agentMessagePinsAtomFamily(input.sessionId)
    const current = get(target)
    if (!input.force && current.status !== 'idle' && current.status !== 'error') return undefined
    set(target, { ...current, status: 'loading', error: undefined })
    try {
      const snapshot = await window.electronAPI.getAgentMessagePins(input.sessionId)
      set(target, { ...snapshot, status: 'ready' })
      return snapshot
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(target, { ...current, status: 'error', error: message })
      throw error
    }
  },
)

export const setAgentMessagePinAtom = atom(
  null,
  async (get, set, input: AgentMessagePinUpdateInput): Promise<AgentMessagePinsSnapshot> => {
    const target = agentMessagePinsAtomFamily(input.sessionId)
    const current = get(target)
    try {
      const snapshot = await window.electronAPI.setAgentMessagePin(input)
      set(target, { ...snapshot, status: 'ready' })
      return snapshot
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(target, { ...current, status: 'error', error: message })
      throw error
    }
  },
)

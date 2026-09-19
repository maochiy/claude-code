import * as React from 'react'
import { Loader2, Pin, PinOff } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { MessageAction } from '@/components/ai-elements/message'
import {
  agentMessagePinsAtomFamily,
  loadAgentMessagePinsAtom,
  setAgentMessagePinAtom,
} from '@/atoms/message-pins'
import { useTranslation } from '@/lib/i18n'

export interface MessagePinActionProps {
  sessionId: string
  messageUuid: string
}

export function MessagePinAction({
  sessionId,
  messageUuid,
}: MessagePinActionProps): React.ReactElement {
  const { language } = useTranslation()
  const state = useAtomValue(agentMessagePinsAtomFamily(sessionId))
  const loadPins = useSetAtom(loadAgentMessagePinsAtom)
  const setPin = useSetAtom(setAgentMessagePinAtom)
  const [updating, setUpdating] = React.useState(false)
  const pinned = state.messageUuids.includes(messageUuid)

  React.useEffect(() => {
    if (state.status !== 'idle') return
    void loadPins({ sessionId }).catch((error: unknown) => {
      console.error('[消息置顶] 加载失败:', error)
    })
  }, [loadPins, sessionId, state.status])

  const handleClick = async (): Promise<void> => {
    if (updating) return
    setUpdating(true)
    try {
      await setPin({ sessionId, messageUuid, pinned: !pinned })
    } catch (error) {
      console.error('[消息置顶] 更新失败:', error)
    } finally {
      setUpdating(false)
    }
  }

  const tooltip = pinned
    ? (language === 'zh' ? '取消置顶消息' : 'Unpin message')
    : (language === 'zh' ? '置顶消息' : 'Pin message')

  return (
    <MessageAction
      tooltip={tooltip}
      aria-pressed={pinned}
      disabled={updating}
      data-agent-message-pin={pinned ? 'pinned' : 'unpinned'}
      onClick={() => { void handleClick() }}
    >
      {updating
        ? <Loader2 className="size-3.5 animate-spin" />
        : pinned
          ? <PinOff className="size-3.5" />
          : <Pin className="size-3.5" />}
    </MessageAction>
  )
}

/** 滚动到当前已加载的原生消息；历史不存在时返回 false，由入口明确提示。 */
export function jumpToAgentMessage(messageUuid: string, root: ParentNode = document): boolean {
  const targets = root.querySelectorAll<HTMLElement>('[data-native-message-uuid]')
  const target = Array.from(targets).find(element => (
    element.dataset.nativeMessageUuid === messageUuid
  ))
  if (!target) return false
  target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  return true
}

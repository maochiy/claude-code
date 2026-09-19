/**
 * useOpenPreview — 统一的预览入口
 *
 * 文件预览统一进入浮动右侧 Files 面板，不占用主内容区。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { openAgentSidePanelTabAtom } from '@/atoms/agent-atoms'
import { previewFileMapAtom, type PreviewFile } from '@/atoms/preview-atoms'

export function useOpenPreview() {
  const store = useStore()

  return React.useCallback(
    (sessionId: string, file: PreviewFile) => {
      store.set(previewFileMapAtom, (prev) => new Map(prev).set(sessionId, file))
      store.set(openAgentSidePanelTabAtom, { sessionId, tab: 'files' })
    },
    [store],
  )
}

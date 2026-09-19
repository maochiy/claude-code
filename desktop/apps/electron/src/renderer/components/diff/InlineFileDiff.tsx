/**
 * InlineFileDiff — 文件改动列表中的内联差异。
 *
 * 每个展开项独立读取内容并在列表原位置渲染，避免把用户带离文件改动面板。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { agentDiffViewModeAtom } from '@/atoms/agent-atoms'
import { useTranslation } from '@/lib/i18n'
import { DiffView } from './DiffView'

interface InlineFileDiffProps {
  dirPath: string
  filePath: string
  gitRoot?: string
  sessionId: string
  baseRef?: string
  refreshVersion?: number
}

interface DiffContents {
  oldContent: string
  newContent: string
}

export function InlineFileDiff({
  dirPath,
  filePath,
  gitRoot,
  sessionId,
  baseRef,
  refreshVersion = 0,
}: InlineFileDiffProps): React.ReactElement {
  const { language } = useTranslation()
  const viewMode = useAtomValue(agentDiffViewModeAtom)
  const [contents, setContents] = React.useState<DiffContents | null>(null)
  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'error'>('loading')

  React.useEffect(() => {
    let cancelled = false
    setLoadState('loading')

    void window.electronAPI.getDiffContents({
      dirPath,
      filePath,
      gitRoot,
      sessionId,
      baseRef,
    }).then((result) => {
      if (cancelled) return
      if (!result) {
        setContents(null)
        setLoadState('error')
        return
      }
      setContents(result)
      setLoadState('ready')
    }).catch(() => {
      if (cancelled) return
      setContents(null)
      setLoadState('error')
    })

    return () => { cancelled = true }
  }, [baseRef, dirPath, filePath, gitRoot, refreshVersion, sessionId])

  if (loadState === 'loading') {
    return (
      <div className="flex h-24 w-full items-center justify-center border-y border-border/35 bg-content-area text-[11px] text-muted-foreground">
        {language === 'zh' ? '正在加载文件改动…' : 'Loading file changes…'}
      </div>
    )
  }

  if (loadState === 'error' || !contents) {
    return (
      <div className="flex h-20 w-full items-center justify-center border-y border-border/35 bg-content-area px-4 text-center text-[11px] text-muted-foreground">
        {language === 'zh' ? '无法加载此文件的改动' : 'Unable to load changes for this file'}
      </div>
    )
  }

  if (contents.oldContent === contents.newContent) {
    return (
      <div className="flex h-20 w-full items-center justify-center border-y border-border/35 bg-content-area px-4 text-center text-[11px] text-muted-foreground">
        {language === 'zh' ? '此文件当前没有可显示的差异' : 'No differences to display for this file'}
      </div>
    )
  }

  return (
    <div
      className="min-h-24 w-full min-w-0 overflow-x-auto border-y border-border/35 bg-content-area"
      data-inline-file-diff={filePath}
    >
      <DiffView
        oldContent={contents.oldContent}
        newContent={contents.newContent}
        filePath={filePath}
        viewMode={viewMode}
      />
    </div>
  )
}

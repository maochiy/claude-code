/**
 * PreviewPanel — 内联预览/Diff 面板
 *
 * 嵌入 AgentView 右侧，始终显示当前选中文件的 diff。
 * Agent 修改文件时自动切换到最新修改的文件。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  previewPanelOpenMapAtom,
  previewFileMapAtom,
} from '@/atoms/preview-atoms'
import {
  agentSessionPathMapAtom,
  currentSessionSidePanelOpenAtom,
} from '@/atoms/agent-atoms'
import { getActiveAccelerator, getAcceleratorDisplay } from '@/lib/shortcut-registry'
import { detectIsWindows, WINDOW_CONTROLS_PADDING_RIGHT } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { DiffTabContent } from './DiffTabContent'
import { DefaultAppOpenButton } from './DefaultAppOpenButton'
import { getDefaultAppTargetPath, getPreviewFileAccess } from './preview-open-path'

interface PreviewPanelProps {
  sessionId: string
}

export function PreviewPanel({ sessionId }: PreviewPanelProps): React.ReactElement {
  const fileMap = useAtomValue(previewFileMapAtom)
  const setOpenMap = useSetAtom(previewPanelOpenMapAtom)
  const isSidePanelOpen = useAtomValue(currentSessionSidePanelOpenAtom)

  const currentFile = fileMap.get(sessionId) ?? null

  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const sessionPath = sessionPathMap.get(sessionId) ?? ''
  const isWindows = detectIsWindows()
  const useStackedWindowsHeader = isWindows && !isSidePanelOpen

  const handleClosePanel = React.useCallback(() => {
    setOpenMap((prev) => new Map(prev).set(sessionId, false))
  }, [sessionId, setOpenMap])

  const fileName = currentFile ? currentFile.filePath.split(/[\\/]/).pop() || currentFile.filePath : '文件预览'
  const defaultAppTargetPath = currentFile ? getDefaultAppTargetPath(currentFile, sessionPath) : ''
  const defaultAppAccess = currentFile ? getPreviewFileAccess(sessionId, currentFile, sessionPath) : undefined
  const fileNameLabel = (
    <span className="truncate text-xs text-muted-foreground">{fileName}</span>
  )
  const previewActions = (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      {currentFile && (
        <DefaultAppOpenButton
          key={defaultAppTargetPath}
          filePath={defaultAppTargetPath}
          access={defaultAppAccess}
        />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClosePanel}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            aria-label="关闭预览面板"
          >
            <X className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>关闭预览面板 ({getAcceleratorDisplay(getActiveAccelerator('toggle-preview-panel'))})</p>
        </TooltipContent>
      </Tooltip>
    </div>
  )

  return (
    <div className="flex h-full flex-col overflow-hidden bg-content-area titlebar-no-drag">
      {/* 顶部栏：文件名 + 预览操作 */}
      <div className={cn('flex-shrink-0 border-b border-border/30 titlebar-no-drag', useStackedWindowsHeader && 'bg-content-area')}>
        {useStackedWindowsHeader ? (
          <>
            <div className={cn('flex h-[34px] items-center pl-3', WINDOW_CONTROLS_PADDING_RIGHT)}>
              {fileNameLabel}
            </div>
            <div className="flex h-[30px] items-center border-t border-border/20 bg-muted/20 px-3">
              {previewActions}
            </div>
          </>
        ) : (
          <div className="flex h-[34px] items-center px-3">
            {fileNameLabel}
            {previewActions}
          </div>
        )}
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {currentFile ? (
          <DiffTabContent
            key={`${sessionId}:${currentFile.filePath}`}
            filePath={currentFile.filePath}
            dirPath={currentFile.dirPath || sessionPath}
            sessionId={sessionId}
            gitRoot={currentFile.gitRoot}
            previewOnly={currentFile.previewOnly}
            readOnly={currentFile.readOnly}
            basePaths={currentFile.basePaths}
            baseRef={currentFile.baseRef}
            onEmptyDiff={handleClosePanel}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
            点击文件查看预览
          </div>
        )}
      </div>
    </div>
  )
}

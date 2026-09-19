/**
 * FilesPanelContent — 浮动右侧 Files 面板。
 *
 * 文件树和消息中的文件入口共享 previewFileMapAtom，因此同一会话始终在这里
 * 展示最近选择的文件。实际预览继续复用 DiffTabContent，以保留代码、Markdown、
 * 图片、PDF/Office 与文本编辑能力。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { FolderOpen, Search, X } from 'lucide-react'
import { useTranslation } from '@/lib/i18n'
import { previewFileMapAtom } from '@/atoms/preview-atoms'
import { FileBrowser } from '@/components/file-browser'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { DiffTabContent } from '@/components/diff/DiffTabContent'
import { getPreviewCandidateBasePaths } from '@/components/diff/preview-open-path'
import { FilePanelDropTarget } from './FilePanelDropTarget'
import type { FilePanelReferenceResult, FilePanelUploadEntry } from './file-panel-actions'

interface FilesPanelContentProps {
  sessionId: string
  /** 会话工作目录（文件树根） */
  sessionPath: string
  /** 保存粘贴/拖入的文件到会话目录 */
  onSaveFiles: (files: FilePanelUploadEntry[]) => Promise<void>
  /** 引用外部文件进会话上下文 */
  onReferenceFiles: (filePaths: string[]) => Promise<FilePanelReferenceResult>
  /** 引用外部目录进会话上下文 */
  onAddDirectories: (directoryPaths: string[]) => Promise<FilePanelReferenceResult>
}

export function FilesPanelContent({
  sessionId,
  sessionPath,
  onSaveFiles,
  onReferenceFiles,
  onAddDirectories,
}: FilesPanelContentProps): React.ReactElement {
  const { t } = useTranslation()
  const [filterQuery, setFilterQuery] = React.useState('')
  const previewFileMap = useAtomValue(previewFileMapAtom)
  const setPreviewFileMap = useSetAtom(previewFileMapAtom)
  const selectedFile = previewFileMap.get(sessionId) ?? null
  const selectedFileName = selectedFile?.filePath.split(/[\\/]/).pop() ?? ''
  const selectedFileBasePaths = React.useMemo(
    () => getPreviewCandidateBasePaths(
      selectedFile?.basePaths,
      selectedFile?.gitRoot,
      selectedFile?.dirPath,
      sessionPath,
    ),
    [selectedFile, sessionPath],
  )

  const handleSelectFile = React.useCallback((filePath: string): void => {
    setPreviewFileMap((previous) => {
      const next = new Map(previous)
      next.set(sessionId, {
        filePath,
        dirPath: sessionPath,
        previewOnly: true,
        basePaths: [sessionPath],
      })
      return next
    })
  }, [sessionId, sessionPath, setPreviewFileMap])

  const handleClosePreview = React.useCallback((): void => {
    setPreviewFileMap((previous) => {
      const next = new Map(previous)
      next.set(sessionId, null)
      return next
    })
  }, [sessionId, setPreviewFileMap])

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* 文件树以 240px 为基准，窄面板时为预览区保留足够空间。 */}
      <div className="flex min-h-0 w-[240px] max-w-[45%] shrink-0 flex-col border-r border-border/70">
        <div className="shrink-0 px-2 pb-1.5 pt-0.5">
          <div className="flex h-7 items-center gap-1.5 rounded-md border border-border/80 bg-content-area px-2 transition-colors focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/10">
            <Search className="size-3 shrink-0 text-muted-foreground" />
            <input
              type="text"
              aria-label={t('sidePanel.filter')}
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
              placeholder={t('sidePanel.filterPlaceholder')}
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
            />
          </div>
        </div>

        <FilePanelDropTarget
          className="min-h-0 min-w-0 flex-1"
          onSaveFiles={onSaveFiles}
          onReferenceFiles={onReferenceFiles}
          onAddDirectories={onAddDirectories}
        >
          <div className="hover-scrollbar-xy h-full min-h-0 min-w-0">
            <FileBrowser
              rootPath={sessionPath}
              hideToolbar
              embedded
              compact
              externalFilter={filterQuery}
              onFilePreview={handleSelectFile}
            />
          </div>
        </FilePanelDropTarget>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!selectedFile ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <FolderOpen className="mb-2 size-5 text-muted-foreground" strokeWidth={1.5} />
            <p className="text-[13px] text-foreground">{t('sidePanel.emptyTitle')}</p>
            <p className="max-w-[280px] text-[12px] leading-4 text-muted-foreground">
              {t('sidePanel.emptyHint')}
            </p>
          </div>
        ) : (
          <>
            <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/40 px-2.5">
              <FileTypeIcon name={selectedFileName} isDirectory={false} size={13} />
              <span
                className="min-w-0 flex-1 truncate text-[12px] text-foreground/80"
                title={selectedFile.filePath}
              >
                {selectedFileName}
              </span>
              <button
                type="button"
                aria-label={t('sidePanel.closePreview')}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
                onClick={handleClosePreview}
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <DiffTabContent
                key={`${sessionId}:${selectedFile.filePath}`}
                filePath={selectedFile.filePath}
                dirPath={selectedFile.dirPath || sessionPath}
                sessionId={sessionId}
                gitRoot={selectedFile.gitRoot}
                previewOnly
                readOnly={selectedFile.readOnly}
                basePaths={selectedFileBasePaths}
                baseRef={selectedFile.baseRef}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * ChatHeader - 对话头部
 *
 * 显示对话标题（可点击编辑）+ 置顶按钮 + 并排模式切换按钮。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Pencil, Check, X, Pin, Columns2 } from 'lucide-react'
import { conversationsAtom } from '@/atoms/chat-atoms'
import { sidebarCollapsedAtom } from '@/atoms/tab-atoms'
import { useConversationParallelMode } from '@/hooks/useConversationSettings'
import type { ConversationMeta } from '@proma/shared'
import { SystemPromptSelector } from './SystemPromptSelector'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { detectIsMac, detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT, WINDOW_CONTROLS_PADDING_RIGHT } from '@/lib/platform'
import { sidebarTopChromeReserve } from '@/lib/sidebar-layout'
import { cn } from '@/lib/utils'

interface ChatHeaderProps {
  conversation: ConversationMeta | null
}

export function ChatHeader({ conversation }: ChatHeaderProps): React.ReactElement | null {
  const isMac = detectIsMac()
  const isWindows = detectIsWindows()
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)
  const setConversations = useSetAtom(conversationsAtom)
  const [parallelMode, setParallelMode] = useConversationParallelMode()
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  if (!conversation) return null

  /** 进入编辑模式 */
  const startEdit = (): void => {
    setEditTitle(conversation.title)
    setEditing(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  /** 保存标题 */
  const saveTitle = async (): Promise<void> => {
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === conversation.title) {
      setEditing(false)
      return
    }

    try {
      const updated = await window.electronAPI.updateConversationTitle(conversation.id, trimmed)
      setConversations((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c))
      )
    } catch (error) {
      console.error('[ChatHeader] 更新标题失败:', error)
    }
    setEditing(false)
  }

  /** 键盘事件 */
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveTitle()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  return (
    <div
      className={cn(
        'relative z-[51] flex items-center gap-2 border-b border-border/35 pr-5',
        isMac ? 'h-[52px]' : 'h-11',
      )}
      style={{
        paddingLeft: sidebarCollapsed ? sidebarTopChromeReserve(isMac) : 20,
      }}
    >
      {/* 与 Agent 标题栏共享主布局的避让范围，保留空白处拖动窗口的能力。 */}
      <div
        className={cn('absolute inset-y-0 right-0 titlebar-drag-region pointer-events-none', isWindows && WINDOW_CONTROLS_INSET_RIGHT)}
        style={{ left: 'var(--main-titlebar-drag-left, 0px)' }}
      />
      {editing ? (
        <div className="flex items-center gap-1.5 flex-1 min-w-0 titlebar-no-drag">
          <input
            ref={inputRef}
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={saveTitle}
            className="flex-1 bg-transparent text-sm font-medium border-b border-primary/50 outline-none px-0 py-0.5 min-w-0"
            maxLength={100}
          />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={saveTitle}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Check className="size-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(false)}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="truncate text-[13px] font-medium text-foreground/90">
            {conversation.title}
          </span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={startEdit}
            className="titlebar-no-drag p-1 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="编辑标题"
          >
            <Pencil className="size-3.5" />
          </button>
        </div>
      )}

      {/* 右侧按钮组 */}
      <div className={cn('ml-auto flex items-center gap-1 titlebar-no-drag', isWindows && WINDOW_CONTROLS_PADDING_RIGHT)}>
        <SystemPromptSelector />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn('h-7 w-7', conversation.pinned && 'bg-accent text-accent-foreground')}
              onClick={async () => {
                const updated = await window.electronAPI.togglePinConversation(conversation.id)
                setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
              }}
            >
              <Pin className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom"><p>{conversation.pinned ? '取消置顶' : '置顶对话'}</p></TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn('h-7 w-7', parallelMode && 'bg-accent text-accent-foreground')}
              onClick={() => setParallelMode(!parallelMode)}
            >
              <Columns2 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom"><p>{parallelMode ? '关闭并排模式' : '并排模式'}</p></TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

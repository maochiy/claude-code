/**
 * MentionSuggestions — Skill / MCP 的 TipTap Mention Suggestion 统一配置
 *
 * 泛型工厂 createMentionSuggestion 封装公共逻辑（渲染、定位、键盘导航），
 * 通过 MentionSuggestionConfig 注入差异部分（触发字符、数据获取、行渲染）。
 */

import type React from 'react'
import { ReactRenderer } from '@tiptap/react'
import type { SuggestionOptions } from '@tiptap/suggestion'
import { MessageSquareText, Sparkles, Server, Terminal } from 'lucide-react'
import { MentionList } from './MentionList'
import type { MentionListRef } from './MentionList'
import { createMentionPopup, positionPopup, isSuggestionTriggerPresent } from './mention-popup-utils'
import type { AgentSessionReferenceSearchResult } from '@proma/shared'
import { getInvocableSkillItems } from '@/lib/runtime-skill-catalog'
import {
  buildAgentSlashSuggestions,
  resolveAgentSlashSelection,
  type AgentSlashSuggestion,
  type AgentSlashUiAction,
} from '@/lib/agent-slash-commands'

// ===== 泛型工厂 =====

interface MentionSuggestionConfig<T> {
  /** 触发字符 */
  char: string
  /** 标题栏左侧标签（面板类型） */
  headerLabel: string | (() => string)
  /** 空列表占位文字 */
  emptyText: string | (() => string)
  /** 异步获取列表项 */
  fetchItems: (slug: string | null, query: string) => Promise<T[]>
  /** 无工作区时仍允许加载候选（用于不依赖工作区的内置命令） */
  allowWithoutWorkspace?: boolean
  /** 提取唯一 key */
  keyExtractor: (item: T) => string
  /** 渲染列表项 */
  renderItem: (item: T) => React.ReactNode
  /** 选中后插入 Mention，或插入可直接发送的纯文本命令 */
  toSelection: (item: T) =>
    | { type: 'mention'; id: string; label: string }
    | { type: 'text'; text: string }
    | { type: 'action'; action: AgentSlashUiAction }
  /** 执行不会进入消息发送链路的输入区 UI 命令 */
  onAction?: (action: AgentSlashUiAction) => void
}

function resolveSuggestionText(value: string | (() => string)): string {
  return typeof value === 'function' ? value() : value
}

function createMentionSuggestion<T>(
  config: MentionSuggestionConfig<T>,
  workspaceSlugRef: React.RefObject<string | null>,
  mentionActiveRef: React.MutableRefObject<boolean>,
  mentionItemCountRef: React.MutableRefObject<number>,
): Omit<SuggestionOptions<T>, 'editor'> {
  return {
    char: config.char,
    allowSpaces: false,
    // allowedPrefixes 为 null：允许任意字符前缀触发（含中文等无空格场景，如 `你好#`）。
    // 注意：设为 [' '] 不能阻止"空输入框触发"——TipTap 在块开头的前缀为空串，
    // 始终通过校验；却会让中文/单词后紧跟触发符无法触发，属回归。
    allowedPrefixes: null,

    items: async ({ query }): Promise<T[]> => {
      const slug = workspaceSlugRef.current
      if (!slug && !config.allowWithoutWorkspace) return []
      try {
        return await config.fetchItems(slug, (query ?? '').toLowerCase())
      } catch {
        return []
      }
    },

    render: () => {
      let renderer: ReactRenderer<MentionListRef> | null = null
      let popup: HTMLDivElement | null = null
      let blurHandler: (() => void) | null = null
      let editorDom: HTMLElement | null = null

      function cleanup() {
        if (blurHandler && editorDom) {
          editorDom.removeEventListener('blur', blurHandler, true)
          blurHandler = null
        }
        editorDom = null
        mentionActiveRef.current = false
        mentionItemCountRef.current = 0
        popup?.remove()
        popup = null
        renderer?.destroy()
        renderer = null
      }

      return {
        onStart(props) {
          if (popup || renderer) {
            cleanup()
          }

          // 防御异步竞态：await items() 期间触发符可能已被删除导致 suggestion 退出，
          // 插件仍会用过期 props 调用 onStart；过期则跳过建弹窗，避免残留幽灵弹窗。
          if (!isSuggestionTriggerPresent(props.editor, props.range, config.char)) {
            return
          }

          mentionActiveRef.current = true
          mentionItemCountRef.current = props.items.length
          editorDom = props.editor.view.dom
          renderer = new ReactRenderer(MentionList, {
            props: {
              items: props.items,
              emptyText: resolveSuggestionText(config.emptyText),
              headerLabel: resolveSuggestionText(config.headerLabel),
              keyExtractor: config.keyExtractor,
              renderItem: config.renderItem,
              onSelect: (item: T) => {
                const selection = config.toSelection(item)
                if (selection.type === 'text') {
                  props.editor.chain().focus().insertContentAt(props.range, selection.text).run()
                  return
                }
                if (selection.type === 'action') {
                  props.editor.chain().focus().deleteRange(props.range).run()
                  config.onAction?.(selection.action)
                  return
                }
                props.command({ id: selection.id, label: selection.label })
              },
            },
            editor: props.editor,
          })
          popup = createMentionPopup(renderer.element)
          positionPopup(popup, props.clientRect?.())

          blurHandler = () => {
            setTimeout(() => {
              if (!props.editor.view.hasFocus() && popup) {
                cleanup()
              }
            }, 100)
          }
          editorDom.addEventListener('blur', blurHandler, true)
        },

        onUpdate(props) {
          mentionItemCountRef.current = props.items.length
          renderer?.updateProps({
            items: props.items,
            emptyText: resolveSuggestionText(config.emptyText),
            headerLabel: resolveSuggestionText(config.headerLabel),
            onSelect: (item: T) => {
              const selection = config.toSelection(item)
              if (selection.type === 'text') {
                props.editor.chain().focus().insertContentAt(props.range, selection.text).run()
                return
              }
              if (selection.type === 'action') {
                props.editor.chain().focus().deleteRange(props.range).run()
                config.onAction?.(selection.action)
                return
              }
              props.command({ id: selection.id, label: selection.label })
            },
          })
          positionPopup(popup, props.clientRect?.())
        },

        onKeyDown(props) {
          return renderer?.ref?.onKeyDown({ event: props.event }) ?? false
        },

        onExit() {
          cleanup()
        },
      }
    },
  }
}

// ===== Slash 命令 / Skill 配置 =====

export interface SkillMentionItem {
  id: string
  name: string
  description?: string
}

export interface SlashMentionLabels {
  header: string
  empty: string
  compactDescription: string
  planDescription: string
  modelDescription: string
}

export function createSlashMentionSuggestion(
  workspaceSlugRef: React.RefObject<string | null>,
  workspaceIdRef: React.RefObject<string | null>,
  sessionIdRef: React.RefObject<string | null>,
  mentionActiveRef: React.MutableRefObject<boolean>,
  mentionItemCountRef: React.MutableRefObject<number>,
  uiActionHandlerRef: React.MutableRefObject<((action: AgentSlashUiAction) => void) | undefined>,
  labelsRef: React.MutableRefObject<SlashMentionLabels>,
) {
  return createMentionSuggestion<AgentSlashSuggestion>(
    {
      char: '/',
      headerLabel: () => labelsRef.current.header,
      emptyText: () => labelsRef.current.empty,
      allowWithoutWorkspace: true,
      fetchItems: async (slug, q) => {
        const workspaceId = workspaceIdRef.current
        const sessionId = sessionIdRef.current
        const availableUiActions: AgentSlashUiAction[] = uiActionHandlerRef.current
          ? ['clear-session', 'enable-plan-mode', 'open-model-selector']
          : []
        const commandCatalogPromise = (sessionId
          ? window.electronAPI.getLocalCliSessionCatalog(sessionId)
          : workspaceId
            ? window.electronAPI.getLocalCliDraftCommandCatalog({ workspaceId })
            : Promise.resolve({ commands: [] }))
          .then((catalog) => catalog.commands)
          .catch((error) => {
            console.warn('[命令建议] Local CLI 命令目录暂不可用:', error)
            return []
          })
        if (!slug) {
          return buildAgentSlashSuggestions(
            [], q, availableUiActions, await commandCatalogPromise,
          )
        }
        try {
          const [caps, runtimeCatalog, commands] = await Promise.all([
            window.electronAPI.getWorkspaceCapabilities(slug),
            workspaceId
              ? window.electronAPI.getAgentRuntimeSkillCatalog(workspaceId)
                  .catch((error) => {
                    console.warn('[技能建议] CCB Skill Catalog 暂不可用，回退到项目技能:', error)
                    return null
                  })
              : Promise.resolve(null),
            commandCatalogPromise,
          ])

          return buildAgentSlashSuggestions(
            getInvocableSkillItems(caps.skills, runtimeCatalog),
            q,
            availableUiActions,
            commands,
          )
        } catch (error) {
          // 工作区 Skill 加载失败不应影响 CLI 原生命令。
          console.warn('[命令建议] 工作区 Skills 暂不可用，仅展示 CLI 命令:', error)
          return buildAgentSlashSuggestions(
            [], q, availableUiActions, await commandCatalogPromise,
          )
        }
      },
      keyExtractor: (item) => item.kind === 'command'
        ? `command:${item.command.id}`
        : `skill:${item.skill.id}`,
      renderItem: (item) => {
        if (item.kind === 'command') {
          return (
            <>
              <Terminal className="size-3.5 text-sky-500 flex-shrink-0" />
              <span className="truncate font-medium flex-1 min-w-0">{item.command.value}</span>
              <span className="truncate text-[10px] text-muted-foreground/50 max-w-[140px]">
                {item.command.description || (item.command.id === 'compact'
                  ? labelsRef.current.compactDescription
                  : item.command.id === 'plan'
                    ? labelsRef.current.planDescription
                    : item.command.id === 'model'
                      ? labelsRef.current.modelDescription
                      : item.command.argumentHint)}
              </span>
            </>
          )
        }
        return (
          <>
            <Sparkles className="size-3.5 text-violet-500 flex-shrink-0" />
            <span className="truncate font-medium flex-1 min-w-0">{item.skill.name}</span>
            {item.skill.description && (
              <span className="truncate text-[10px] text-muted-foreground/50 max-w-[120px]">{item.skill.description}</span>
            )}
          </>
        )
      },
      toSelection: resolveAgentSlashSelection,
      onAction: (action) => uiActionHandlerRef.current?.(action),
    },
    workspaceSlugRef,
    mentionActiveRef,
    mentionItemCountRef,
  )
}

// ===== MCP 配置 =====

export interface McpMentionItem {
  id: string
  name: string
  type: string
}

export function createMcpMentionSuggestion(
  workspaceSlugRef: React.RefObject<string | null>,
  mentionActiveRef: React.MutableRefObject<boolean>,
  mentionItemCountRef: React.MutableRefObject<number>,
) {
  return createMentionSuggestion<McpMentionItem>(
    {
      char: '#',
      headerLabel: 'MCP 服务',
      emptyText: '无匹配 MCP 服务',
      fetchItems: async (slug, q) => {
        if (!slug) return []
        const caps = await window.electronAPI.getWorkspaceCapabilities(slug)
        return caps.mcpServers
          .filter((s) => s.enabled)
          .filter((s) => !q || s.name.toLowerCase().includes(q))
          .map((s) => ({ id: s.name, name: s.name, type: s.type }))
      },
      keyExtractor: (item) => item.id,
      renderItem: (item) => (
        <>
          <Server className="size-3.5 text-emerald-500 flex-shrink-0" />
          <span className="truncate font-medium flex-1 min-w-0">{item.name}</span>
          <span className="truncate text-[10px] text-muted-foreground/50 max-w-[120px]">{item.type}</span>
        </>
      ),
      toSelection: (item) => ({ type: 'mention', id: item.id, label: item.name }),
    },
    workspaceSlugRef,
    mentionActiveRef,
    mentionItemCountRef,
  )
}

// ===== Agent 会话引用配置 =====

export type SessionMentionItem = AgentSessionReferenceSearchResult

// 空查询只读会话索引，可安全展示更多；搜索会读取 JSONL 消息，保持较小上限避免阻塞主进程。
const RECENT_SESSION_MENTION_LIMIT = 200
const SEARCHED_SESSION_MENTION_LIMIT = 20

export function createSessionMentionSuggestion(
  workspaceIdRef: React.RefObject<string | null>,
  currentSessionIdRef: React.RefObject<string | null>,
  mentionActiveRef: React.MutableRefObject<boolean>,
  mentionItemCountRef: React.MutableRefObject<number>,
) {
  return createMentionSuggestion<SessionMentionItem>(
    {
      char: '&',
      headerLabel: '引用会话',
      emptyText: '无匹配会话',
      fetchItems: async (_slug, q) => {
        const workspaceId = workspaceIdRef.current
        if (!workspaceId) return []
        return window.electronAPI.searchAgentSessionReferences({
          workspaceId,
          excludeSessionId: currentSessionIdRef.current ?? undefined,
          query: q,
          limit: q ? SEARCHED_SESSION_MENTION_LIMIT : RECENT_SESSION_MENTION_LIMIT,
        })
      },
      keyExtractor: (item) => item.sessionId,
      renderItem: (item) => (
        <>
          <MessageSquareText className="size-3.5 text-sky-500 flex-shrink-0" />
          <span className="truncate font-medium flex-1 min-w-0">{item.title}</span>
          {item.snippet && (
            <span className="truncate text-[10px] text-muted-foreground/50 max-w-[120px]">{item.snippet}</span>
          )}
        </>
      ),
      toSelection: (item) => ({ type: 'mention', id: item.sessionId, label: item.title }),
    },
    // 会话引用不依赖 slug，但复用通用 mention 工厂时需要一个非空 ref 才会触发 fetchItems。
    workspaceIdRef,
    mentionActiveRef,
    mentionItemCountRef,
  )
}

/**
 * HomeComposer — 主页输入区（Claude 桌面端样式）
 *
 * Cowork：白底 chips + 大圆角输入卡（内部工具栏 + 骑跨发送按钮）。
 * Code：白底 chips + 紧凑单行输入（右侧 Effort 卡片）+ 下方工具行（审批模式 / 模型 + 档位徽章）。
 * 回车/发送提交：创建会话并把文本注入其自动发送队列，会话打开后立即开始首轮运行
 * （对齐桌面端「主页发送即开始任务」；不再预填输入框等用户二次发送）。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { toast } from 'sonner'
import { ArrowUp, Check, ClipboardList, Monitor, Paperclip, Plus, RotateCw, Shield, PenLine, Zap } from 'lucide-react'
import {
  MAX_ATTACHMENT_SIZE,
  type AttachmentSaveInput,
  type FileAttachment,
  type LocalCliSlashCommand,
  type ModelOption,
  type PromaPermissionMode,
} from '@proma/shared'
import { appModeAtom } from '@/atoms/app-mode'
import { chatPendingMessageAtom } from '@/atoms/chat-atoms'
import {
  agentChannelIdAtom,
  agentChannelIdsAtom,
  agentMessageQueueAtomFamily,
  agentModelIdAtom,
  agentRuntimeModelCatalogsAtom,
  agentThinkingEffortLevelAtom,
  getAgentRuntimeModelCatalogKey,
  homeAgentPermissionModeAtom,
} from '@/atoms/agent-atoms'
import { AgentProjectPicker } from '@/components/agent/AgentProjectPicker'
import { InputToolbarOverflow, type ToolbarItem } from '@/components/ai-elements/InputToolbarOverflow'
import { inputCardClass } from '@/components/ai-elements/input-toolbar-styles'
import { EffortBadge, HomeEffortCard } from '@/components/home/HomeEffortCard'
import { ModelSelector } from '@/components/chat/ModelSelector'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { createAgentQueuedMessage } from '@/lib/agent-message-queue'
import type { AgentQueuedAttachment } from '@/lib/agent-message-queue'
import { useCreateSession } from '@/hooks/useCreateSession'
import { useProjectActions } from '@/hooks/useProjectActions'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'
import { cn } from '@/lib/utils'
import { useTranslation, type TranslationKey } from '@/lib/i18n'
import { findAgentRuntimeModel } from '@/lib/agent-thinking-effort'
import { formatFileNames } from '@/lib/file-utils'
import { makeUniqueAttachmentName } from '@/lib/clipboard-text-attachment'
import { HomeGitControls } from './HomeGitControls'
import {
  filterHomeSlashCommands,
  getHomeSlashQuery,
  HomeSlashCommandMenu,
  resolveHomeCommandCatalogWorkspaceId,
} from './HomeSlashCommandMenu'
import { getHomeAgentGitContext, homeGitSelectionByWorkspaceAtom, isHomeGitContextReady } from '@/atoms/home-git'
import { HomeAttachmentStrip, type HomePendingAttachment } from './HomeAttachmentStrip'

interface HomeAttachmentApi {
  saveAttachment: (input: AttachmentSaveInput) => Promise<{ attachment: FileAttachment }>
  saveFilesToAgentSession: (input: {
    workspaceSlug: string
    sessionId: string
    files: Array<{ filename: string; data: string }>
  }) => Promise<Array<{ filename: string; targetPath: string }>>
}

export async function saveHomeChatAttachments(
  conversationId: string,
  attachments: HomePendingAttachment[],
  api: Pick<HomeAttachmentApi, 'saveAttachment'>,
): Promise<FileAttachment[]> {
  return Promise.all(attachments.map(async attachment => {
    const result = await api.saveAttachment({
      conversationId,
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      data: attachment.data,
    })
    return result.attachment
  }))
}

export async function saveHomeAgentAttachments(input: {
  workspaceSlug: string
  sessionId: string
  attachments: HomePendingAttachment[]
  api: Pick<HomeAttachmentApi, 'saveFilesToAgentSession'>
}): Promise<AgentQueuedAttachment[]> {
  if (input.attachments.length === 0) return []
  const saved = await input.api.saveFilesToAgentSession({
    workspaceSlug: input.workspaceSlug,
    sessionId: input.sessionId,
    files: input.attachments.map(item => ({ filename: item.filename, data: item.data })),
  })
  if (saved.length !== input.attachments.length) {
    throw new Error('附件保存结果不完整')
  }
  return saved.map((file, index) => {
    const source = input.attachments[index]
    if (!source) throw new Error('附件保存结果无法匹配原文件')
    return {
      filename: file.filename,
      targetPath: file.targetPath,
      mediaType: source.mediaType,
      size: source.size,
    }
  })
}

function buildAgentAttachmentReferenceBlock(attachments: AgentQueuedAttachment[]): string {
  if (attachments.length === 0) return ''
  const refs = attachments.map(item => `- ${item.filename}: ${item.targetPath}`).join('\n')
  return `<attached_files>\n${refs}\n</attached_files>\n\n`
}

/** 主页审批标签与会话内文案区分，对齐桌面端审批模式命名 */
const HOME_PERMISSION_LABEL_KEYS: Record<PromaPermissionMode, TranslationKey> = {
  default: 'permission.manual',
  acceptEdits: 'permission.acceptEdits',
  dontAsk: 'permission.dontAsk',
  bypassPermissions: 'permission.bypass',
  auto: 'permission.auto',
  plan: 'permission.plan',
}

const HOME_PERMISSION_DESCRIPTION_KEYS: Record<PromaPermissionMode, TranslationKey> = {
  default: 'permission.manualDescription',
  acceptEdits: 'permission.acceptEditsDescription',
  dontAsk: 'permission.dontAskDescription',
  bypassPermissions: 'permission.bypassDescription',
  auto: 'permission.autoDescription',
  plan: 'permission.planDescription',
}

const HOME_PERMISSION_ICONS: Record<PromaPermissionMode, React.ComponentType<{ className?: string }>> = {
  default: Shield,
  acceptEdits: PenLine,
  dontAsk: Shield,
  bypassPermissions: Zap,
  auto: Zap,
  plan: ClipboardList,
}

export type HomeAutoModeAvailability = 'checking' | 'supported' | 'unsupported'

/** 首页按原生顺序展示五种审批模式和独立 Plan；安全设置仍可隐藏 bypass。 */
export function getHomePermissionModes(allowBypass: boolean): PromaPermissionMode[] {
  return [
    'default',
    'acceptEdits',
    'dontAsk',
    'plan',
    ...(allowBypass ? ['bypassPermissions' as const] : []),
    'auto',
  ]
}

export function getHomePermissionDescriptionKey(
  mode: PromaPermissionMode,
  autoModeAvailability: HomeAutoModeAvailability,
): TranslationKey {
  if (mode !== 'auto' || autoModeAvailability === 'supported') {
    return HOME_PERMISSION_DESCRIPTION_KEYS[mode]
  }
  return autoModeAvailability === 'checking'
    ? 'permission.autoChecking'
    : 'permission.autoUnavailable'
}

interface HomePermissionChipProps {
  autoModeAvailability: HomeAutoModeAvailability
}

function HomePermissionChip({ autoModeAvailability }: HomePermissionChipProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [mode, setMode] = useAtom(homeAgentPermissionModeAtom)
  const allowBypass = useAtomValue(settingsPreferencesAtom).allowBypassPermissionsMode
  const label = t(HOME_PERMISSION_LABEL_KEYS[mode])

  const selectMode = React.useCallback((nextMode: PromaPermissionMode): void => {
    if (nextMode === 'auto' && autoModeAvailability !== 'supported') return
    setMode(nextMode)
    setOpen(false)
  }, [autoModeAvailability, setMode])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${t('home.permissionMode')}：${label}`}
          className={cn(
            'flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-foreground/85',
            'transition-colors hover:bg-muted/55 hover:text-foreground',
            'data-[state=open]:bg-muted/55 data-[state=open]:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <span>{label}</span>
          <Plus className="size-3 text-foreground/70" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64 rounded-xl p-1.5"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground">
          {t('home.permissionMode')}
        </div>
        {getHomePermissionModes(allowBypass).map((nextMode) => {
          const Icon = HOME_PERMISSION_ICONS[nextMode]
          const selected = nextMode === mode
          const autoUnavailable = nextMode === 'auto' && autoModeAvailability !== 'supported'
          const descriptionKey = getHomePermissionDescriptionKey(nextMode, autoModeAvailability)
          return (
            <button
              key={nextMode}
              type="button"
              onClick={() => selectMode(nextMode)}
              disabled={autoUnavailable}
              aria-disabled={autoUnavailable}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                'hover:bg-accent/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                selected && 'bg-accent/55',
                autoUnavailable && 'cursor-not-allowed opacity-55 hover:bg-transparent',
              )}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-foreground/70">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  {t(HOME_PERMISSION_LABEL_KEYS[nextMode])}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t(descriptionKey)}
                </span>
              </span>
              {selected && <Check className="size-4 shrink-0 text-foreground/65" />}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Effort 档位徽章 + 点击弹层（参考截图 4）：工具行不固定展示卡片，
 * 点击档位徽章后在上方弹出 Effort 卡片，选择即写回全局默认档位。
 */
function HomeEffortBadgeTrigger(): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const level = useAtomValue(agentThinkingEffortLevelAtom) ?? 'medium'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('home.thinkingLevel', { level: t(`effort.${level}`) })}
          className={cn(
            'flex h-7 shrink-0 items-center rounded-md px-1 transition-colors',
            'hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            'data-[state=open]:bg-muted/55',
          )}
        >
          <EffortBadge level={level} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-auto border-none bg-transparent p-0 shadow-none"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <HomeEffortCard />
      </PopoverContent>
    </Popover>
  )
}

export function HomeComposer(): React.ReactElement {
  const { t } = useTranslation()
  const mode = useAtomValue(appModeAtom)
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const agentChannelIds = useAtomValue(agentChannelIdsAtom)
  const [runtimeModelCatalogs, setRuntimeModelCatalogs] = useAtom(agentRuntimeModelCatalogsAtom)
  const homePermissionMode = useAtomValue(homeAgentPermissionModeAtom)
  const setAgentChannelId = useSetAtom(agentChannelIdAtom)
  const setAgentModelId = useSetAtom(agentModelIdAtom)
  const setChatPendingMessage = useSetAtom(chatPendingMessageAtom)
  const store = useStore()
  const { createChat, createAgent } = useCreateSession()
  const { workspaces, currentWorkspaceId, selectProject, addProject } = useProjectActions()
  const homeGitSelections = useAtomValue(homeGitSelectionByWorkspaceAtom)

  const [value, setValue] = React.useState('')
  const [attachments, setAttachments] = React.useState<HomePendingAttachment[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  const [gitReadyWorkspaceId, setGitReadyWorkspaceId] = React.useState<string | null>(null)
  const [slashCommands, setSlashCommands] = React.useState<LocalCliSlashCommand[]>([])
  const [slashCommandsLoading, setSlashCommandsLoading] = React.useState(false)
  const [slashSelectedIndex, setSlashSelectedIndex] = React.useState(0)
  const [dismissedSlashValue, setDismissedSlashValue] = React.useState<string | null>(null)
  const [runtimeCatalogFailed, setRuntimeCatalogFailed] = React.useState(false)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const gitContextReady = isHomeGitContextReady(currentWorkspaceId, gitReadyWorkspaceId)
  const commandCatalogWorkspaceId = resolveHomeCommandCatalogWorkspaceId(
    currentWorkspaceId,
    workspaces,
  )
  const slashQuery = mode === 'agent' ? getHomeSlashQuery(value) : null
  const slashMenuOpen = slashQuery !== null
    && commandCatalogWorkspaceId !== null
    && dismissedSlashValue !== value
  const filteredSlashCommands = React.useMemo(
    () => filterHomeSlashCommands(slashCommands, slashQuery ?? ''),
    [slashCommands, slashQuery],
  )

  const runtimeCatalogKey = agentChannelId
    ? getAgentRuntimeModelCatalogKey(currentWorkspaceId, agentChannelId)
    : null
  const runtimeCatalog = runtimeCatalogKey
    ? runtimeModelCatalogs.get(runtimeCatalogKey)
    : undefined
  const selectedRuntimeModel = React.useMemo(
    () => findAgentRuntimeModel(runtimeCatalog?.models ?? [], agentModelId),
    [agentModelId, runtimeCatalog],
  )
  const autoModeAvailability: HomeAutoModeAvailability = selectedRuntimeModel
    ? selectedRuntimeModel.supportsAutoMode ? 'supported' : 'unsupported'
    : agentChannelId && agentModelId && !runtimeCatalog && !runtimeCatalogFailed
      ? 'checking'
      : 'unsupported'

  React.useEffect(() => {
    if (mode !== 'agent' || !agentChannelId) return
    let cancelled = false
    setRuntimeCatalogFailed(false)
    void window.electronAPI.getAgentRuntimeModelCatalog(
      agentChannelId,
      undefined,
      currentWorkspaceId ?? undefined,
    ).then((catalog) => {
      if (cancelled) return
      setRuntimeModelCatalogs((previous) => {
        const next = new Map(previous)
        next.set(getAgentRuntimeModelCatalogKey(currentWorkspaceId, agentChannelId), catalog)
        return next
      })
    }).catch((error) => {
      if (cancelled) return
      setRuntimeCatalogFailed(true)
      console.warn('[主页模式] Runtime 模型能力目录暂不可用:', error)
    })
    return () => { cancelled = true }
  }, [agentChannelId, currentWorkspaceId, mode, setRuntimeModelCatalogs])

  React.useEffect(() => {
    if (!slashMenuOpen || !commandCatalogWorkspaceId) return
    let cancelled = false
    setSlashCommands([])
    setSlashCommandsLoading(true)
    void window.electronAPI.getLocalCliDraftCommandCatalog({ workspaceId: commandCatalogWorkspaceId })
      .then((catalog) => {
        if (!cancelled) setSlashCommands(catalog.commands)
      })
      .catch((error) => {
        if (!cancelled) {
          setSlashCommands([])
          console.warn('[主页命令建议] Local CLI 命令目录暂不可用:', error)
        }
      })
      .finally(() => {
        if (!cancelled) setSlashCommandsLoading(false)
      })
    return () => { cancelled = true }
  // 查询只跟菜单开关和项目关联，输入 query 变化后在本地过滤，避免反复启动 initialize。
  }, [slashMenuOpen, commandCatalogWorkspaceId])

  React.useEffect(() => {
    setSlashSelectedIndex(0)
  }, [slashQuery])

  const handleGitReadyChange = React.useCallback((ready: boolean): void => {
    setGitReadyWorkspaceId(ready ? currentWorkspaceId : null)
  }, [currentWorkspaceId])

  const handleOpenFileDialog = React.useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.openFileDialog()
      const oversized = [
        ...(result.largeFiles ?? []).map(file => file.filename),
        ...result.files.filter(file => file.size > MAX_ATTACHMENT_SIZE).map(file => file.filename),
      ]
      const skipped = (result.skippedFiles ?? []).map(file => file.filename)
      const usedNames = attachments.map(item => item.filename)
      const added: HomePendingAttachment[] = []
      for (const file of result.files) {
        if (file.size > MAX_ATTACHMENT_SIZE) continue
        const filename = makeUniqueAttachmentName(file.filename, usedNames)
        usedNames.push(filename)
        added.push({
          id: crypto.randomUUID(),
          filename,
          mediaType: file.mediaType,
          size: file.size,
          data: file.data,
          ...(file.mediaType.startsWith('image/')
            ? { previewUrl: `data:${file.mediaType};base64,${file.data}` }
            : {}),
        })
      }
      if (added.length > 0) setAttachments(previous => [...previous, ...added])
      if (oversized.length > 0) {
        toast.error(t('home.attachmentTooLarge', { files: formatFileNames(oversized) }))
      }
      if (skipped.length > 0) {
        toast.warning(t('home.attachmentUnreadable', { files: formatFileNames(skipped) }))
      }
    } catch (error) {
      console.error('[主页附件] 选择文件失败:', error)
      toast.error(t('home.attachmentFailed'))
    }
  }, [attachments, t])

  const handleRemoveAttachment = React.useCallback((id: string): void => {
    setAttachments(previous => previous.filter(item => item.id !== id))
  }, [])

  const agentSelectedModel = agentChannelId && agentModelId
    ? { channelId: agentChannelId, modelId: agentModelId }
    : null

  /** 输入内容增高：1～5 行自适应 */
  const autoResize = React.useCallback((): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
  }, [])

  const handleSubmit = React.useCallback(async (): Promise<void> => {
    const text = value.trim()
    if ((!text && attachments.length === 0) || submitting || (mode === 'agent' && !gitContextReady)) return
    if (mode === 'agent' && homePermissionMode === 'auto' && autoModeAvailability !== 'supported') {
      toast.error(t(autoModeAvailability === 'checking'
        ? 'permission.autoChecking'
        : 'permission.autoUnavailable'))
      return
    }
    setSubmitting(true)
    try {
      let created = false
      if (mode === 'chat') {
        const attachmentsSnapshot = [...attachments]
        const id = await createChat({
          draft: true,
          prepareChat: async meta => {
            const savedAttachments = await saveHomeChatAttachments(
              meta.id,
              attachmentsSnapshot,
              window.electronAPI,
            )
            setChatPendingMessage({
              conversationId: meta.id,
              message: text,
              ...(savedAttachments.length > 0 ? { attachments: savedAttachments } : {}),
            })
          },
        })
        if (id) {
          created = true
        }
      } else {
        const workspace = workspaces.find(item => item.id === currentWorkspaceId)
        const attachmentsSnapshot = [...attachments]
        let queuedAttachments: AgentQueuedAttachment[] = []
        const gitSelection = getHomeAgentGitContext(homeGitSelections, currentWorkspaceId)
        const id = await createAgent({
          draft: true,
          permissionMode: homePermissionMode,
          ...(gitSelection ? { gitContext: gitSelection } : {}),
          prepareAgent: async meta => {
            if (attachmentsSnapshot.length === 0) return
            if (!workspace) throw new Error(t('home.attachmentNeedsProject'))
            queuedAttachments = await saveHomeAgentAttachments({
              workspaceSlug: workspace.slug,
              sessionId: meta.id,
              attachments: attachmentsSnapshot,
              api: window.electronAPI,
            })
          },
        })
        if (id) {
          created = true
          // 主页发送 = 立即开始回合：文本注入新会话的自动发送队列，
          // AgentView 挂载并完成消息加载后由队列自动发送机制开启首轮运行，
          // 不再预填输入框让用户二次点击发送。
          store.set(agentMessageQueueAtomFamily(id), (prev) => [
            ...prev,
            createAgentQueuedMessage(text, crypto.randomUUID(), Date.now(), null, queuedAttachments.length > 0
              ? {
                  fileReferenceBlock: buildAgentAttachmentReferenceBlock(queuedAttachments),
                  attachments: queuedAttachments,
                }
              : undefined),
          ])
        }
      }
      if (created) {
        setValue('')
        setAttachments([])
        requestAnimationFrame(() => autoResize())
      }
    } finally {
      setSubmitting(false)
    }
  }, [value, attachments, submitting, mode, gitContextReady, homePermissionMode, autoModeAvailability, t, createChat, createAgent, setChatPendingMessage, store, autoResize, currentWorkspaceId, homeGitSelections, workspaces])

  const selectSlashCommand = React.useCallback((command: LocalCliSlashCommand): void => {
    setValue(`/${command.name.replace(/^\/+/, '')} `)
    setDismissedSlashValue(null)
    requestAnimationFrame(() => {
      autoResize()
      textareaRef.current?.focus()
    })
  }, [autoResize])

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashMenuOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedSlashValue(value)
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (filteredSlashCommands.length > 0) {
          setSlashSelectedIndex((previous) => event.key === 'ArrowDown'
            ? (previous + 1) % filteredSlashCommands.length
            : (previous - 1 + filteredSlashCommands.length) % filteredSlashCommands.length)
        }
        return
      }
      if (event.key === 'Enter' && filteredSlashCommands.length > 0) {
        event.preventDefault()
        const selected = filteredSlashCommands[slashSelectedIndex]
        if (selected) selectSlashCommand(selected)
        return
      }
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void handleSubmit()
  }, [filteredSlashCommands, handleSubmit, selectSlashCommand, slashMenuOpen, slashSelectedIndex, value])

  const handleAgentModelSelect = React.useCallback((option: ModelOption): void => {
    setAgentChannelId(option.channelId)
    setAgentModelId(option.modelId)
    window.electronAPI.updateSettings({
      agentChannelId: option.channelId,
      agentModelId: option.modelId,
    }).catch(console.error)
  }, [setAgentChannelId, setAgentModelId])

  const handleProjectAdd = React.useCallback(async (): Promise<boolean> => {
    const workspace = await addProject()
    return workspace !== null
  }, [addProject])

  const canSubmit = (value.trim().length > 0 || attachments.length > 0)
    && !submitting
    && (mode !== 'agent' || gitContextReady)

  const toolbarItems = React.useMemo<ToolbarItem[]>(() => [
    {
      key: 'add',
      node: (
        <button
          type="button"
          aria-label={t('home.attach')}
          title={t('home.attach')}
          onClick={() => { void handleOpenFileDialog() }}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/60',
            'transition-colors hover:bg-muted/55 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          )}
        >
          <Plus className="size-[18px]" />
        </button>
      ),
    },
  ], [handleOpenFileDialog, t])

  const chatModelTrigger = (
    <ModelSelector
      textOnlyTrigger
      excludedProviders={['openai-codex']}
    />
  )

  return (
    <div className="w-full" data-home-composer>
      {/* 上下文 chips：白底描边胶囊（Local + 项目） */}
      <div className="mb-2 flex min-h-8 items-end gap-1.5">
        <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-black/[0.08] bg-card px-2.5 text-xs text-foreground/80">
          <Monitor className="size-3.5 shrink-0" />
          {t('common.local')}
        </span>
        {mode === 'agent' && (
          <>
            <AgentProjectPicker
              workspaces={workspaces}
              workspaceId={currentWorkspaceId}
              onSelect={selectProject}
              onAdd={handleProjectAdd}
            />
            <HomeGitControls
              workspaces={workspaces}
              workspaceId={currentWorkspaceId}
              onReadyChange={handleGitReadyChange}
            />
          </>
        )}
      </div>

      {mode === 'agent' ? (
        <>
          <HomeAttachmentStrip attachments={attachments} onRemove={handleRemoveAttachment} />
          {/* Code 主页：紧凑单行输入（Effort 卡片改为点击工具行档位徽章后弹出） */}
          <div className="relative min-w-0 flex-1">
            {slashMenuOpen && (
              <HomeSlashCommandMenu
                commands={filteredSlashCommands}
                loading={slashCommandsLoading}
                selectedIndex={slashSelectedIndex}
                onSelect={selectSlashCommand}
              />
            )}
            <textarea
              ref={textareaRef}
              value={value}
              rows={1}
              placeholder={t('home.prompt')}
              aria-label={t('home.newSessionInput')}
              onChange={(event) => {
                setValue(event.target.value)
                setDismissedSlashValue(null)
                autoResize()
              }}
              onKeyDown={handleKeyDown}
              className="block w-full resize-none rounded-lg border border-black/[0.08] bg-card px-3.5 py-2.5 pr-11 text-[13.5px] leading-5 text-foreground shadow-[0_1px_3px_rgba(15,23,42,0.04)] outline-none placeholder:text-muted-foreground/70"
            />
            {canSubmit && (
              <button
                type="button"
                aria-label={t('home.send')}
                onClick={() => void handleSubmit()}
                className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_1px_3px_rgb(60_50_30/0.22)] transition-colors hover:bg-primary/90"
              >
                {submitting
                  ? <RotateCw className="size-[13px] animate-spin" />
                  : <ArrowUp className="size-[13px]" strokeWidth={2.8} />}
              </button>
            )}
          </div>

          {/* 工具行：左侧审批模式纯文字按钮，右侧模型 + 当前档位徽章 */}
          <div className="mt-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1">
              <HomePermissionChip autoModeAvailability={autoModeAvailability} />
              <button
                type="button"
                aria-label={t('home.attach')}
                title={t('home.attach')}
                onClick={() => { void handleOpenFileDialog() }}
                className="flex size-7 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-muted/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <Paperclip className="size-4" />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <ModelSelector
                textOnlyTrigger
                externalSelectedModel={agentSelectedModel}
                onModelSelect={handleAgentModelSelect}
                filterChannelIds={agentChannelIds.length > 0 ? agentChannelIds : undefined}
              />
              <HomeEffortBadgeTrigger />
            </div>
          </div>
        </>
      ) : (
        /* Cowork 主页：陶土色发送按钮骑跨在卡片右上角 */
        <div className="relative">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'absolute -top-3 right-3 z-10 flex size-6 items-center justify-center rounded-full',
              'bg-primary text-primary-foreground shadow-[0_1px_3px_rgb(60_50_30/0.22)]',
              'transition-colors hover:bg-primary/90 hover:text-primary-foreground',
              'disabled:opacity-40',
            )}
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            aria-label={t('home.send')}
          >
            {submitting
              ? <RotateCw className="size-[13px] animate-spin" />
              : <ArrowUp className="size-[13px]" strokeWidth={2.8} />}
          </Button>

          <div className={inputCardClass} data-input-mode="chat">
            {attachments.length > 0 && (
              <div className="px-3 pt-2">
                <HomeAttachmentStrip attachments={attachments} onRemove={handleRemoveAttachment} />
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={value}
              rows={1}
              placeholder={t('home.prompt')}
              aria-label={t('home.newSessionInput')}
              onChange={(event) => {
                setValue(event.target.value)
                autoResize()
              }}
              onKeyDown={handleKeyDown}
              className="block w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
            />
            <InputToolbarOverflow items={toolbarItems} trailing={chatModelTrigger} />
          </div>
        </div>
      )}
    </div>
  )
}

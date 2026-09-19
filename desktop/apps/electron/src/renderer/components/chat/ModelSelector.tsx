/**
 * ModelSelector - 模型选择器（输入区内联 Popover，对齐参考截图 1-4）
 *
 * 弹层：白底圆角 10 + 投影，灰色「Models」组头 + 平铺模型列表，
 * 行尾灰色序号；不做渠道分组、搜索与配额徽章。
 * 触发按钮保持紧凑，适合放在输入区工具栏。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ChevronDown, Cpu } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  conversationsAtom,
  selectedModelAtom,
  channelsAtom,
  channelsLoadedAtom,
  modelSelectorOpenAtom,
} from '@/atoms/chat-atoms'
import { useConversationModelOptional } from '@/hooks/useConversationSettings'
import { useConversationIdOptional } from '@/contexts/session-context'
import { getModelLogo } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n'
import type { Channel, ModelOption, ProviderType } from '@proma/shared'

/** 从渠道列表构建扁平化的模型选项 */
export function buildModelOptions(
  channels: Channel[],
  filterChannelId?: string,
  filterChannelIds?: string[],
  excludedProviders?: readonly ProviderType[],
): ModelOption[] {
  const options: ModelOption[] = []

  for (const channel of channels) {
    if (!channel.enabled) continue
    if (filterChannelId && channel.id !== filterChannelId) continue
    if (filterChannelIds && !filterChannelIds.includes(channel.id)) continue
    if (excludedProviders?.includes(channel.provider)) continue

    for (const model of channel.models) {
      if (!model.enabled) continue

      options.push({
        channelId: channel.id,
        channelName: channel.name,
        modelId: model.id,
        modelName: model.name,
        provider: channel.provider,
        thinkingEffortLevels: model.thinkingEffortLevels,
        defaultThinkingEffortLevel: model.defaultThinkingEffortLevel,
      })
    }
  }

  return options
}

/** ModelSelector 可选属性 */
interface ModelSelectorProps {
  /** 仅显示此渠道的模型 */
  filterChannelId?: string
  /** 仅显示这些渠道的模型（多渠道过滤） */
  filterChannelIds?: string[]
  /** 外部选中模型（不传则用内部 selectedModelAtom） */
  externalSelectedModel?: { channelId: string; modelId: string } | null
  /** 外部选择回调 */
  onModelSelect?: (option: ModelOption) => void
  /** 触发按钮是否显示「渠道 · 模型」（默认只显示模型名） */
  showChannelInTrigger?: boolean
  /** 不在此选择器中显示的供应商（例如 Chat 暂不支持的协议） */
  excludedProviders?: readonly ProviderType[]
  /** 是否使用全局 modelSelectorOpenAtom 控制打开状态（用于外部拉起，如错误提示按钮） */
  useSharedOpenState?: boolean
  /** Agent 模式由 CCB Runtime 返回的模型选项；传入后不再从 Channel 模型配置构建列表 */
  runtimeModelOptions?: ModelOption[]
  /** CCB Runtime 模型目录是否仍在加载 */
  runtimeModelsLoading?: boolean
  /** 触发器仅显示文字和展开箭头，用于 Codex 风格输入区 */
  textOnlyTrigger?: boolean
  /** 触发器是否显示模型 Logo（默认显示；textOnlyTrigger 下可通过此属性开启） */
  showTriggerLogo?: boolean
}

export function ModelSelector({
  filterChannelId,
  filterChannelIds,
  externalSelectedModel,
  onModelSelect,
  showChannelInTrigger = false,
  excludedProviders,
  useSharedOpenState = false,
  runtimeModelOptions,
  runtimeModelsLoading = false,
  textOnlyTrigger = false,
  showTriggerLogo = false,
}: ModelSelectorProps = {}): React.ReactElement {
  const { language } = useTranslation()
  const [conversationModel, setConversationModel] = useConversationModelOptional()
  const conversationId = useConversationIdOptional()
  const setConversations = useSetAtom(conversationsAtom)
  const setGlobalModel = useSetAtom(selectedModelAtom)
  const channels = useAtomValue(channelsAtom)
  const channelsLoaded = useAtomValue(channelsLoadedAtom)
  const setChannels = useSetAtom(channelsAtom)
  const [localOpen, setLocalOpen] = React.useState(false)
  const [sharedOpen, setSharedOpen] = useAtom(modelSelectorOpenAtom)
  const open = useSharedOpenState ? sharedOpen : localOpen
  const setOpen = useSharedOpenState ? setSharedOpen : setLocalOpen
  const listRef = React.useRef<HTMLDivElement>(null)

  // 外部模型优先 → per-conversation 模型
  const selectedModel = externalSelectedModel !== undefined ? externalSelectedModel : conversationModel

  // 每次打开菜单时刷新渠道列表，确保最新
  React.useEffect(() => {
    if (open) {
      window.electronAPI.listChannels().then(setChannels).catch(console.error)
    }
  }, [open, setChannels])

  const modelOptions = React.useMemo(
    () => runtimeModelOptions
      ?? buildModelOptions(
        channels,
        filterChannelId,
        filterChannelIds,
        excludedProviders,
      ),
    [
      channels,
      excludedProviders,
      filterChannelId,
      filterChannelIds,
      runtimeModelOptions,
    ],
  )

  // 键盘高亮索引
  const [highlightIndex, setHighlightIndex] = React.useState(-1)
  const itemRefs = React.useRef<Map<number, HTMLButtonElement>>(new Map())

  // 高亮项变化时滚动到可见区域
  React.useEffect(() => {
    if (highlightIndex < 0) return
    const el = itemRefs.current.get(highlightIndex)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  // 查找当前选中的模型信息
  const currentModelInfo = React.useMemo(() => {
    if (!selectedModel) return null
    const exact = modelOptions.find(
      (o) => o.channelId === selectedModel.channelId && o.modelId === selectedModel.modelId
    )
    if (exact || runtimeModelOptions === undefined) return exact ?? null

    const normalizedModelId = selectedModel.modelId.replace(/\[1m\]$/i, '')
    return modelOptions.find(
      (o) =>
        o.channelId === selectedModel.channelId
        && o.modelId === normalizedModelId,
    ) ?? null
  }, [selectedModel, modelOptions, runtimeModelOptions])

  // 保持上次有效的模型信息，避免渠道未加载时闪烁"选择模型"
  const stableModelInfoRef = React.useRef(currentModelInfo)
  if (currentModelInfo) stableModelInfoRef.current = currentModelInfo
  const displayModelInfo = currentModelInfo ?? stableModelInfoRef.current

  /** 选择模型并持久化到当前对话 */
  const handleSelect = (option: ModelOption): void => {
    if (onModelSelect) {
      onModelSelect(option)
      setOpen(false)
      return
    }

    // Chat 模式：写入 per-conversation Map + 同步全局默认值
    if (setConversationModel) {
      setConversationModel({ channelId: option.channelId, modelId: option.modelId })
    }
    setGlobalModel({ channelId: option.channelId, modelId: option.modelId })
    setOpen(false)

    // 将模型/渠道选择保存到当前对话元数据
    if (conversationId) {
      window.electronAPI
        .updateConversationModel(conversationId, option.modelId, option.channelId)
        .then((updated) => {
          setConversations((prev) =>
            prev.map((c) => (c.id === updated.id ? updated : c))
          )
        })
        .catch(console.error)
    }
  }

  /** 列表键盘导航 */
  const handleListKeyDown = (event: React.KeyboardEvent): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) return
    if (modelOptions.length === 0) return
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = modelOptions[highlightIndex >= 0 ? highlightIndex : 0]
      if (target) handleSelect(target)
      return
    }
    event.preventDefault()
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? modelOptions.length - 1
      : event.key === 'ArrowUp' ? (highlightIndex <= 0 ? modelOptions.length : highlightIndex) - 1
      : (highlightIndex + 1) % modelOptions.length
    setHighlightIndex(nextIndex)
    itemRefs.current.get(nextIndex)?.focus()
  }

  if (runtimeModelsLoading && modelOptions.length === 0) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
        <Cpu className="size-3.5 animate-pulse" />
        <span>{language === 'zh' ? '加载模型…' : 'Loading models…'}</span>
      </div>
    )
  }

  if ((runtimeModelOptions !== undefined || channelsLoaded) && modelOptions.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-2 py-1">
        <Cpu className="size-3.5" />
        <span>{language === 'zh' ? '暂无可用模型' : 'No models available'}</span>
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={nextOpen => { setOpen(nextOpen); if (!nextOpen) setHighlightIndex(-1) }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={displayModelInfo ? `${language === 'zh' ? '当前模型' : 'Current model'}: ${displayModelInfo.modelName}` : (language === 'zh' ? '选择模型' : 'Select model')}
          aria-expanded={open}
          className="model-selector-trigger flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
        >
          {(!textOnlyTrigger || showTriggerLogo) && (
            displayModelInfo ? (
              <img
                src={getModelLogo(displayModelInfo.modelId, displayModelInfo.provider)}
                alt=""
                className="size-4 rounded object-cover"
              />
            ) : (
              <Cpu className="size-3.5 text-muted-foreground/80" />
            )
          )}
          <span className="min-w-0 max-w-[160px] truncate">
            {displayModelInfo
              ? (showChannelInTrigger ? `${displayModelInfo.channelName} · ${displayModelInfo.modelName}` : displayModelInfo.modelName)
              : (language === 'zh' ? '选择模型' : 'Select model')}
          </span>
          {!textOnlyTrigger && <ChevronDown className="size-3 shrink-0" />}
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-[240px] rounded-[10px] p-1.5"
      >
        {/* 参考截图 1-4：灰色「Models」组头 + 平铺列表 + 行尾灰色序号 */}
        <div className="px-2 pb-1 pt-1.5 text-[12px] leading-4 text-muted-foreground">Models</div>
        <div
          ref={listRef}
          onKeyDown={handleListKeyDown}
          className="scrollbar-none max-h-[min(320px,calc(100vh-160px))] overflow-y-auto overscroll-contain"
        >
          {modelOptions.map((option, index) => {
            const isSelected =
              selectedModel?.channelId === option.channelId &&
              selectedModel?.modelId === option.modelId
            const isHighlighted = index === highlightIndex

            return (
              <button
                key={`${option.channelId}:${option.modelId}`}
                ref={(el) => {
                  if (el) itemRefs.current.set(index, el)
                  else itemRefs.current.delete(index)
                }}
                type="button"
                onClick={() => handleSelect(option)}
                onMouseEnter={() => setHighlightIndex(index)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                  'hover:bg-accent/70',
                  isHighlighted && 'bg-accent/70',
                )}
              >
                <span className={cn(
                  'min-w-0 flex-1 truncate',
                  isSelected ? 'font-medium text-foreground' : 'text-foreground/80',
                )}>
                  {option.modelName}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                  {index + 1}
                </span>
              </button>
            )
          })}
          {modelOptions.length === 0 && (
            <div className="py-8 text-center text-[13px] text-muted-foreground">
              {language === 'zh' ? '暂无可用模型' : 'No models available'}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

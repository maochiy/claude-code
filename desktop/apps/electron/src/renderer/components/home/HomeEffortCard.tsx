/**
 * HomeEffortCard — Code 主页右侧的 Effort 滑块卡片（对齐参考截图 4）。
 *
 * 绑定全局默认思考等级 agentThinkingEffortLevelAtom：修改即写入 settings.json，
 * 新会话由 AgentView 以「会话级覆盖 ?? 全局默认」的方式继承。
 * 主页没有 Runtime 模型目录，档位列表直接使用 THINKING_EFFORT_ORDER（5 档）。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { CircleHelp } from 'lucide-react'
import type { ThinkingEffortLevel } from '@proma/shared'
import { agentThinkingEffortLevelAtom } from '@/atoms/agent-atoms'
import {
  getThinkingEffortKeyIndex,
  snapThinkingEffortPosition,
  THINKING_EFFORT_ORDER,
} from '@/lib/agent-thinking-effort'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n'

/** 模型名右侧的当前档位灰色徽章（参考截图 4/5 底部工具行） */
export function EffortBadge({ level }: { level: ThinkingEffortLevel }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <span className="flex h-[18px] shrink-0 items-center rounded-[5px] bg-foreground/[0.07] px-1.5 text-[11px] font-medium leading-none text-foreground/70">
      {t(`effort.${level}`)}
    </span>
  )
}

interface EffortCardProps {
  /** 可选档位（从低到高），例如 5 档 THINKING_EFFORT_ORDER 或 Runtime 声明的子集 */
  levels: readonly ThinkingEffortLevel[]
  level: ThinkingEffortLevel
  onLevelChange: (level: ThinkingEffortLevel) => void
  /** 弹层场景追加投影等样式 */
  className?: string
  ariaLabel?: string
}

/**
 * Effort 卡片本体（参考截图 4）：白底 1px 描边圆角 10，
 * 「Effort + 当前档位」标题行、两端 Faster/Smarter、连续滑轨。
 * 滑轨按参考图 4 实测：20px 高圆角连续条，左侧 #D6D5D2 填充至 thumb，
 * 白色圆形 thumb（16px），余段 #ECEBE7，档位处 1×3px 小刻度（#A3A3A0，
 * 下一档刻度提亮为紫色 #8E6BD9 示意可升档），无分段缝。
 */
export function EffortCard({
  levels,
  level,
  onLevelChange,
  className,
  ariaLabel,
}: EffortCardProps): React.ReactElement {
  const { language, t } = useTranslation()
  const currentIndex = Math.max(0, levels.indexOf(level))
  const levelCount = levels.length

  /** 刻度/thumb 位置：内缩 5.5% 起止，档位均匀分布（参考图 4：两端 11px 边距） */
  const markPercent = React.useCallback(
    (index: number): number => 5.5 + (89 * index) / Math.max(levelCount - 1, 1),
    [levelCount],
  )
  const thumbPercent = markPercent(currentIndex)
  /** 点击区：首段从 0 起、末段到 100%，中段以相邻刻度中点为界 */
  const zones = levels.map((levelKey, index) => {
    const start = index === 0 ? 0 : (markPercent(index - 1) + markPercent(index)) / 2
    const end = index === levelCount - 1 ? 100 : (markPercent(index) + markPercent(index + 1)) / 2
    return { levelKey, left: start, width: end - start }
  })

  const selectIndex = React.useCallback((index: number): void => {
    const next = levels[index]
    if (!next || next === level) return
    onLevelChange(next)
  }, [levels, level, onLevelChange])

  /** 连续拖动/点击：把指针横坐标映射到最近档位（起止内缩与 markPercent 对齐） */
  const trackRef = React.useRef<HTMLDivElement>(null)
  const draggingRef = React.useRef(false)
  const selectFromClientX = React.useCallback((clientX: number): void => {
    if (levelCount <= 1) return
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const mapped = ((ratio * 100 - 5.5) / 89) * (levelCount - 1)
    selectIndex(snapThinkingEffortPosition(Math.round(mapped), levelCount))
  }, [levelCount, selectIndex])

  const handleTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    draggingRef.current = true
    // 捕获指针：拖出轨道仍持续跟随，且松手不会误触发档位 button 的 click
    const track = event.currentTarget
    track.setPointerCapture(event.pointerId)
    selectFromClientX(event.clientX)
  }
  const handleTrackPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    selectFromClientX(event.clientX)
  }
  const endTrackDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = getThinkingEffortKeyIndex(event.key, currentIndex, levelCount)
    if (index === undefined) return
    event.preventDefault()
    selectIndex(index)
  }

  return (
    <div className={cn('w-[220px] rounded-[10px] border border-black/[0.07] bg-card px-3 pb-3.5 pt-2.5', className)}>
      {/* 头部：标题 + 当前档位徽章 + 说明提示（对齐参考截图 Effort 标题行） */}
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] font-medium text-foreground">{language === 'zh' ? '思考强度' : 'Effort'}</span>
        <EffortBadge level={level} />
        <span
          className="ml-auto flex size-4 cursor-default items-center justify-center text-foreground/35 transition-colors hover:text-foreground/60"
          aria-label={language === 'zh' ? '思考等级说明' : 'Thinking level help'}
          title={language === 'zh' ? '等级越高思考越深入：从更快到更聪明' : 'Higher levels think more deeply: from faster to smarter'}
        >
          <CircleHelp className="size-3.5" />
        </span>
      </div>

      {/* 两端语义标签 */}
      <div className="mt-2 flex items-center justify-between text-[11px] leading-4 text-muted-foreground">
        <span>{language === 'zh' ? '更快' : 'Faster'}</span>
        <span>{language === 'zh' ? '更聪明' : 'Smarter'}</span>
      </div>

      {/* 连续滑轨：填充 + thumb + 刻度，档位分段为透明点击区（参考图 4） */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel ?? (language === 'zh' ? '思考等级' : 'Thinking level')}
        aria-valuemin={1}
        aria-valuemax={levelCount}
        aria-valuenow={currentIndex + 1}
        aria-valuetext={t(`effort.${level}`)}
        onKeyDown={handleKeyDown}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={endTrackDrag}
        onPointerCancel={endTrackDrag}
        className="relative mt-1.5 h-5 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {/* 余段（右侧未选中） */}
        <div
          className="absolute inset-y-0 rounded-full bg-[#ECEBE7] dark:bg-white/[0.10]"
          style={{ left: `${thumbPercent}%`, right: 0 }}
        />
        {/* 填充（至 thumb 处） */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[#D6D5D2] dark:bg-white/[0.28]"
          style={{ width: `${thumbPercent}%` }}
        />
        {/* 档位刻度：1px 核心宽、3px 高，垂直居中；下一档紫色提示可升档 */}
        {levels.map((levelKey, index) => (
          <span
            key={levelKey}
            className={cn(
              'absolute top-1/2 h-[3px] w-px -translate-y-1/2',
              index === currentIndex + 1
                ? 'bg-[#8E6BD9] dark:bg-[#A78BFA]'
                : 'bg-[#A3A3A0] dark:bg-white/[0.40]',
            )}
            style={{ left: `${markPercent(index)}%` }}
          />
        ))}
        {/* thumb：白色圆形 */}
        <div
          className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.20)] dark:bg-white"
          style={{ left: `${thumbPercent}%` }}
        />
        {/* 点击区：透明档位分段，保持 aria-pressed 结构 */}
        {zones.map((zone, index) => (
          <button
            key={zone.levelKey}
            type="button"
            aria-label={t('effort.levelAria', { level: t(`effort.${zone.levelKey}`) })}
            aria-pressed={index === currentIndex}
            onClick={() => selectIndex(index)}
            className="absolute inset-y-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            style={{ left: `${zone.left}%`, width: `${zone.width}%` }}
          />
        ))}
      </div>
    </div>
  )
}

/** 主页卡片：绑定全局默认档位并持久化 */
export function HomeEffortCard(): React.ReactElement {
  const [level, setLevel] = useAtom(agentThinkingEffortLevelAtom)
  const current = level ?? 'medium'

  const handleLevelChange = React.useCallback((next: ThinkingEffortLevel): void => {
    setLevel(next)
    window.electronAPI.updateSettings({ agentThinkingEffortLevel: next }).catch(console.error)
  }, [setLevel])

  return <EffortCard levels={THINKING_EFFORT_ORDER} level={current} onLevelChange={handleLevelChange} />
}

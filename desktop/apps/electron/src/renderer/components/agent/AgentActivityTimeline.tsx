import * as React from 'react'
import { atom, useAtom } from 'jotai'
import { ChevronRight } from 'lucide-react'
import { useSmoothStream } from '@proma/ui'
import type { SDKThinkingBlock } from '@proma/shared'
import { cn } from '@/lib/utils'
import type { AgentActivityItem } from '@/lib/agent-turn-presentation'
import { buildAgentActivityTimeline, getToolGroupLabel } from '@/lib/agent-activity-timeline'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { createTimelineExpansionAtom } from '@/atoms/agent-timeline-atoms'
import { MessageResponse } from '@/components/ai-elements/message'
import { useTranslation, type InterfaceLanguage } from '@/lib/i18n'

interface ActivityDisclosureProps {
  label: string
  running?: boolean
  defaultExpanded?: boolean
  forceExpanded?: boolean
  kind: 'thinking' | 'tools'
  stateKey?: string
  children: React.ReactNode
}

/** 折叠态思考标签：取思考正文首行前 24 字符作内容摘要（对齐参考截图样式），空内容回退英文固定文案 */
function getThinkingLabel(
  content: string,
  running: boolean,
  displayed: string,
  language: InterfaceLanguage,
): string {
  const source = (running ? displayed : content).trim()
  const firstLine = source.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  const plain = firstLine?.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim() ?? ''
  if (plain) {
    return plain.length > 24 ? `${plain.slice(0, 24)}…` : plain
  }
  if (language === 'zh') return running ? '正在思考' : '思考过程'
  return running ? 'Thinking' : 'Thought process'
}

/** 每个时间线节点独立展开；收到流式增量不重置用户的展开选择。 */
export function ActivityDisclosure({
  label, running, defaultExpanded = false, forceExpanded, kind, stateKey, children,
}: ActivityDisclosureProps): React.ReactElement {
  const expansionAtom = React.useMemo(() => stateKey
    ? createTimelineExpansionAtom(stateKey)
    : atom<boolean | undefined>(undefined), [stateKey])
  const [expanded, setExpanded] = useAtom(expansionAtom)
  const open = forceExpanded || (expanded ?? defaultExpanded)
  return (
    <Collapsible open={open} onOpenChange={setExpanded} data-agent-timeline-entry={kind}>
      <CollapsibleTrigger
        disabled={forceExpanded}
        className="group/activity inline-flex min-h-6 max-w-full items-center gap-1 rounded-sm text-left text-[13px] leading-5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-100"
      >
        <span role={running ? 'status' : undefined} className={cn('truncate', running && 'agent-status-shimmer')}>{label}</span>
        <ChevronRight className={cn(
          'size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 motion-reduce:transition-none',
          open && 'rotate-90',
        )} />
      </CollapsibleTrigger>
      <CollapsibleContent className="agent-timeline-disclosure overflow-hidden">
        <div className="pb-1 pt-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

interface ThinkingActivityProps {
  content: string
  running?: boolean
  forceExpanded?: boolean
  stateKey?: string
}

export function ThinkingActivity({
  content, running = false, forceExpanded = false, stateKey,
}: ThinkingActivityProps): React.ReactElement {
  const { language } = useTranslation()
  const { displayedContent } = useSmoothStream({
    content, isStreaming: running, minDelay: 0, maxCharsPerFrame: 2,
  })
  if (!content.trim()) {
    return (
      <div role="status" className="py-1 text-[13px] leading-5 text-muted-foreground">
        <span className={cn(running && 'agent-status-shimmer')}>
          {language === 'zh' ? (running ? '正在思考' : '思考过程') : (running ? 'Thinking' : 'Thought process')}
        </span>
      </div>
    )
  }
  const body = (
    <div className="agent-thinking-content break-words" data-agent-thinking-content>
      <MessageResponse className="text-[14px] leading-[22px] prose-p:my-4 prose-p:leading-[22px] prose-li:leading-[22px] prose-headings:text-[14px]">
        {displayedContent}
      </MessageResponse>
    </div>
  )

  // 思考正文默认收起；展开选择保存在时间线状态中，流式增量不会覆盖用户选择。
  // 不创建独立滚动窗，展开时仍由外层会话跟随最新内容。
  return (
    <ActivityDisclosure label={getThinkingLabel(content, running, displayedContent, language)} running={running}
      kind="thinking" forceExpanded={forceExpanded} stateKey={stateKey}>
      {body}
    </ActivityDisclosure>
  )
}

interface AgentActivityTimelineProps {
  items: AgentActivityItem[]
  renderItem: (item: AgentActivityItem) => React.ReactNode
  /** 停止/失败保留工具明细；完整转录同时展开思考正文。 */
  revealTools?: boolean
  fullTranscript?: boolean
  stateKey?: string
  failedToolIds?: ReadonlySet<string>
}

export function AgentActivityTimeline({
  items, renderItem, revealTools, fullTranscript, stateKey, failedToolIds,
}: AgentActivityTimelineProps): React.ReactElement {
  const { language } = useTranslation()
  return (
    <div className="space-y-2" data-agent-timeline>
      {buildAgentActivityTimeline(items).map((entry) => {
        if (entry.kind === 'thinking') {
          return <ThinkingActivity key={entry.id}
            stateKey={stateKey ? `${stateKey}/${entry.id}` : undefined}
            content={entry.items.map((item) => (item.block as SDKThinkingBlock).thinking ?? '').join('\n\n')}
            running={entry.items.some((item) => item.running)}
            forceExpanded={fullTranscript}
          />
        }
        if (entry.kind === 'tools') {
          const failureCount = entry.items.filter((item) =>
            item.block.type === 'tool_use' && failedToolIds?.has(item.block.id as string),
          ).length
          return (
            <ActivityDisclosure key={entry.id} kind="tools"
              stateKey={stateKey ? `${stateKey}/${entry.id}` : undefined}
              label={getToolGroupLabel(entry.items, failureCount, language, failedToolIds)}
              running={entry.items.some((item) => item.running)}
              defaultExpanded={revealTools || failureCount > 0}
              forceExpanded={fullTranscript}
            >
              <div className="space-y-0.5 rounded-lg border border-border/45 bg-muted/20 px-2.5 py-1.5" data-agent-tool-group-content>
                {entry.items.map((item) => (
                  <React.Fragment key={item.index}>
                    {item.block.type === 'thinking' ? (
                      <ThinkingActivity
                        content={(item.block as SDKThinkingBlock).thinking ?? ''}
                        stateKey={stateKey ? `${stateKey}/thinking:${item.index}` : undefined}
                        forceExpanded={fullTranscript}
                      />
                    ) : renderItem(item)}
                  </React.Fragment>
                ))}
              </div>
            </ActivityDisclosure>
          )
        }
        return (
          <React.Fragment key={entry.id}>
            {entry.items.map((item) => (
              <React.Fragment key={item.index}>{renderItem(item)}</React.Fragment>
            ))}
          </React.Fragment>
        )
      })}
    </div>
  )
}

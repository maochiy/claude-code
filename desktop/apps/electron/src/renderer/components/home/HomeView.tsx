/**
 * HomeView — 主页空态（Claude 桌面端样式）
 *
 * 当没有打开任何标签页时展示：
 * - 顶部「✳ What's up next, {name}?」问候语 + 真实用量统计灰卡（480px）
 * - 底部钉住的大圆角输入区，回车创建新会话
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Asterisk } from 'lucide-react'
import { userProfileAtom } from '@/atoms/user-profile'
import type { UserUsageSummary } from '@/types/user-profile'
import { HomeStatsPanel } from './HomeStatsPanel'
import { HomeComposer } from './HomeComposer'
import { useTranslation } from '@/lib/i18n'

const EMPTY_USAGE_SUMMARY: UserUsageSummary = {
  checkedAt: 0,
  stats: {
    totalTokens: 0,
    peakDayTokens: 0,
    peakDay: '',
    longestChatDurationMs: 0,
    currentStreakDays: 0,
    longestStreakDays: 0,
    requests: 0,
    chatCount: 0,
    agentSessionCount: 0,
    fastModeRate: 0,
    skillsExplored: 0,
    skillUses: 0,
  },
  days: [],
  models: [],
  skills: [],
}

export function HomeView(): React.ReactElement {
  const { t } = useTranslation()
  const userProfile = useAtomValue(userProfileAtom)
  const [summary, setSummary] = React.useState<UserUsageSummary>(EMPTY_USAGE_SUMMARY)
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI.getUserUsageSummary().then((data) => {
      if (cancelled) return
      setSummary(data)
      setLoaded(true)
    }).catch((error: unknown) => {
      console.error('[主页] 加载用量统计失败:', error)
      if (!cancelled) setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const displayName = userProfile.userName || t('home.friend')

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex h-full w-full max-w-[768px] flex-col px-6">
        {/* 问候语：陶土色星芒 logo + 衬线标题 */}
        <h1 className="flex items-center gap-2 pt-14 text-[22px] font-semibold tracking-tight text-foreground">
          <Asterisk size={20} className="shrink-0 text-primary" strokeWidth={2.4} />
          <span className="font-serif">{t('home.greeting', { name: displayName })}</span>
        </h1>

        {/* 统计面板：480px 灰卡，与问候语左对齐 */}
        <div className="mt-12">
          <HomeStatsPanel summary={summary} loaded={loaded} />
        </div>

        {/* 弹性撑开：输入区钉在窗口底部（对齐桌面端布局） */}
        <div className="min-h-6 flex-1" />
        <div className="pb-3">
          <HomeComposer />
        </div>
      </div>
    </div>
  )
}

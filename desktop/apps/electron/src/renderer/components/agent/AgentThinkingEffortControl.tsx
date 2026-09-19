import * as React from 'react'
import type { ThinkingEffortLevel } from '@proma/shared'
import {
  getThinkingEffortSliderLevels,
  type AgentThinkingEffortCapability,
} from '@/lib/agent-thinking-effort'
import { EffortCard } from '@/components/home/HomeEffortCard'
import { useTranslation } from '@/lib/i18n'

interface AgentThinkingEffortControlProps {
  capability: AgentThinkingEffortCapability | null
  value?: ThinkingEffortLevel
  onValueChange: (value: ThinkingEffortLevel) => void
}

/** 模型弹层旁的思考等级卡片（参考截图 4）；与主页 Effort 卡片共用同一组件。 */
export function AgentThinkingEffortControl({
  capability,
  value,
  onValueChange,
}: AgentThinkingEffortControlProps): React.ReactElement {
  const { t } = useTranslation()
  const selectedLevel = value ?? capability?.defaultLevel ?? 'medium'
  const levels = React.useMemo(
    () => getThinkingEffortSliderLevels(capability?.levels ?? [], selectedLevel),
    [capability?.levels, selectedLevel],
  )

  if (levels.length === 0) {
    return (
      <div className="w-[220px] rounded-[10px] border border-black/[0.07] bg-card px-3 py-3.5 text-center text-xs text-muted-foreground shadow-[0_8px_28px_rgba(0,0,0,0.14)]">
        {t('effort.unavailable')}
      </div>
    )
  }

  return (
    <EffortCard
      levels={levels}
      level={selectedLevel}
      onLevelChange={onValueChange}
      className="shadow-[0_8px_28px_rgba(0,0,0,0.14)]"
    />
  )
}

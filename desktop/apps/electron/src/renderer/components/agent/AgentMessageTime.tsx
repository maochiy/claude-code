import * as React from 'react'
import { useTranslation } from '@/lib/i18n'
import { formatMessageAge } from '@/lib/message-presentation'

/** 与运行时无关的消息时间；完整日期放在悬停提示中。 */
export function AgentMessageTime({ timestamp }: { timestamp: number }): React.ReactElement {
  const { language } = useTranslation()
  const [now, setNow] = React.useState(Date.now)
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const date = new Date(timestamp)
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(language === 'zh' ? 'zh-CN' : 'en')}
      className="text-[13px] text-muted-foreground"
    >
      {formatMessageAge(timestamp, now, language)}
    </time>
  )
}

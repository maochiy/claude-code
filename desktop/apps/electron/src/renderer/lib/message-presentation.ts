/** 适配持久化消息的时间字段，视图只接收毫秒时间戳。 */
export function getMessageTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== 'object') return undefined
  const fields = message as Record<string, unknown>
  for (const value of [fields._createdAt, fields.timestamp]) {
    const timestamp = typeof value === 'number'
      ? value
      : typeof value === 'string' ? Date.parse(value) : NaN
    if (Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8.64e15) return timestamp
  }
  return undefined
}

export function formatMessageAge(timestamp: number, now: number, language: 'zh' | 'en'): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return language === 'zh' ? '刚刚' : 'Just now'
  const unit = seconds < 3600 ? 'minute' : seconds < 86400 ? 'hour' : 'day'
  const divisor = unit === 'minute' ? 60 : unit === 'hour' ? 3600 : 86400
  return new Intl.RelativeTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { numeric: 'always' })
    .format(-Math.floor(seconds / divisor), unit)
}

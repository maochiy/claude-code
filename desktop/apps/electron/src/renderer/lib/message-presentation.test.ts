import { describe, expect, test } from 'bun:test'
import { formatMessageAge, getMessageTimestamp } from './message-presentation'

describe('消息时间适配', () => {
  test('Given 不同内核的持久化字段 When 适配 Then 使用有效时间且不伪造缺失时间', () => {
    const time = Date.parse('2026-09-17T10:00:00Z')
    expect(getMessageTimestamp({ _createdAt: time })).toBe(time)
    expect(getMessageTimestamp({ timestamp: '2026-09-17T10:00:00Z' })).toBe(time)
    expect(getMessageTimestamp({ _createdAt: NaN, timestamp: '2026-09-17T10:00:00Z' })).toBe(time)
    for (const value of [undefined, {}, { _createdAt: Infinity }, { timestamp: 'invalid' }]) {
      expect(getMessageTimestamp(value)).toBeUndefined()
    }
  })

  test('Given 历史或略超前的时间 When 切换语言 Then 相对时间准确且不会显示负数', () => {
    const time = 1_800_000_000_000
    expect(formatMessageAge(time, time + 120_000, 'en')).toBe('2 minutes ago')
    expect(formatMessageAge(time, time + 7_200_000, 'zh')).toBe('2小时前')
    expect(formatMessageAge(time, time - 1000, 'zh')).toBe('刚刚')
  })
})

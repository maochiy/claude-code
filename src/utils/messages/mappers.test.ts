import { describe, expect, test } from 'bun:test'
import type { CompactMetadata } from '../../types/message.js'
import { fromSDKCompactMetadata, toSDKCompactMetadata } from './mappers.js'

describe('compact metadata desktop fields', () => {
  test('Given CCB compaction metadata When converted to SDK Then post tokens and summary preview are retained', () => {
    const sdk = toSDKCompactMetadata({
      trigger: 'auto',
      preTokens: 168_000,
      postTokens: 24_000,
      summary: '已整理当前任务上下文。',
    } as CompactMetadata)

    expect(sdk).toMatchObject({
      trigger: 'auto',
      pre_tokens: 168_000,
      post_tokens: 24_000,
      summary: '已整理当前任务上下文。',
    })
  })

  test('Given SDK compaction metadata When restored Then desktop fields survive round trip', () => {
    const metadata = fromSDKCompactMetadata({
      trigger: 'manual',
      pre_tokens: 96_000,
      post_tokens: 18_000,
      summary: '保留必要上下文。',
    }) as CompactMetadata

    expect(metadata).toMatchObject({
      trigger: 'manual',
      preTokens: 96_000,
      postTokens: 18_000,
      summary: '保留必要上下文。',
    })
  })
})

import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import {
  SDKControlGetContextUsageResponseSchema,
  SDKControlRequestInnerSchema,
} from '../controlSchemas.js'
import {
  SDKAutoModeClassifierMessageSchema,
  SDKCompactBoundaryMessageSchema,
} from '../coreSchemas.js'

describe('desktop control protocol', () => {
  test('accepts session effort and auto-compact controls including clear', () => {
    const requestSchema = SDKControlRequestInnerSchema()
    expect(
      requestSchema.safeParse({ subtype: 'set_effort', effort: null }).success,
    ).toBe(true)
    expect(
      requestSchema.safeParse({ subtype: 'set_effort', effort: 'xhigh' })
        .success,
    ).toBe(true)
    expect(
      requestSchema.safeParse({ subtype: 'set_auto_compact', enabled: null })
        .success,
    ).toBe(true)
    expect(
      requestSchema.safeParse({ subtype: 'set_auto_compact', enabled: false })
        .success,
    ).toBe(true)
  })

  test('accepts host Skill directories at initialize and during refresh', () => {
    const requestSchema = SDKControlRequestInnerSchema()
    expect(
      requestSchema.safeParse({
        subtype: 'initialize',
        additionalSkillDirectories: ['/workspace/.proma/skills'],
      }).success,
    ).toBe(true)
    expect(
      requestSchema.safeParse({
        subtype: 'set_skill_directories',
        directories: ['/workspace/.proma/skills'],
      }).success,
    ).toBe(true)
    expect(
      requestSchema.safeParse({
        subtype: 'set_skill_directories',
        directories: [1],
      }).success,
    ).toBe(false)
  })

  test('keeps cache statistics in structured context responses', () => {
    const result = SDKControlGetContextUsageResponseSchema().safeParse({
      categories: [],
      totalTokens: 1,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 1,
      gridRows: [],
      model: 'test-model',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: null,
      cacheHitRate: 95,
      cacheThreshold: 80,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cacheHitRate).toBe(95)
      expect(result.data.cacheThreshold).toBe(80)
    }
  })

  test('accepts post-compact estimates and classifier status events', () => {
    expect(
      SDKCompactBoundaryMessageSchema().safeParse({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 180_000,
          post_tokens: 20_000,
          summary: 'Summary preview',
        },
        uuid: randomUUID(),
        session_id: 'session',
      }).success,
    ).toBe(true)

    expect(
      SDKAutoModeClassifierMessageSchema().safeParse({
        type: 'system',
        subtype: 'auto_mode_classifier',
        status: 'allowed',
        call_id: 'classifier-call-1',
        usage_scope: 'classifier_call',
        usage_included_in_result: false,
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        model: 'classifier-model',
        duration_ms: 25,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 0,
        },
        uuid: randomUUID(),
        session_id: 'session',
      }).success,
    ).toBe(true)
  })
})

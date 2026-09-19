import { describe, expect, test } from 'bun:test'
import {
  normalizeLocalCliCommandCatalog,
  normalizeLocalCliContextUsage,
  queryLocalCliDraftCommandCatalog,
} from './catalog-service'
import type { LocalServiceEvent } from './client'

describe('Local CLI catalog normalization', () => {
  test('Given initialize 返回动态命令 When 归一化 Then 保留顺序、说明与参数且不补写固定命令', () => {
    expect(normalizeLocalCliCommandCatalog('session-a', {
      commands: [
        { name: 'review', description: 'Review changes', argumentHint: '<path>' },
        { name: '/compact', description: 'Compact context', argument_hint: '[focus]' },
        { name: 'review', description: 'duplicate' },
      ],
    })).toEqual({
      sessionId: 'session-a',
      commands: [
        { name: 'review', description: 'Review changes', argumentHint: '<path>' },
        { name: 'compact', description: 'Compact context', argumentHint: '[focus]' },
      ],
    })
  })

  test('Given CLI 只返回 supported_commands 字符串 When 归一化 Then 使用真实目录且跳过无效项', () => {
    expect(normalizeLocalCliCommandCatalog('session-b', {
      supported_commands: ['/doctor', '', 42],
    }).commands).toEqual([
      { name: 'doctor', description: '', argumentHint: '' },
    ])
  })

  test('Given initialize 响应不是实际 catalog When 归一化 Then 明确失败而不是返回空命令', () => {
    expect(() => normalizeLocalCliCommandCatalog('session-c', { accepted: true }))
      .toThrow('缺少命令目录')
  })
})

describe('新建会话 Local CLI 命令目录', () => {
  test('Given 首页尚无 Session When 查询命令目录 Then 仅临时 open/initialize/close 且不发送消息', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    let listener: ((event: LocalServiceEvent) => void) | undefined
    const client = {
      request: async <T = Record<string, unknown>>(
        method: string,
        params: Record<string, unknown> = {},
      ): Promise<T> => {
        requests.push({ method, params })
        if (method === 'session.control') {
          queueMicrotask(() => listener?.({
            type: 'desktop_event',
            protocolVersion: 1,
            eventId: 'event-1',
            sessionId: 'draft-catalog-session',
            generation: 1,
            seq: 1,
            timestamp: 1,
            source: 'cli',
            kind: 'control_resolved',
            requestId: 'initialize-request',
            payload: {
              direction: 'host_to_cli',
              response: {
                subtype: 'success',
                response: {
                  commands: [{ name: 'review', description: 'Review changes' }],
                },
              },
            },
          }))
        }
        return {} as T
      },
      subscribe: (next: (event: LocalServiceEvent) => void): (() => void) => {
        listener = next
        return () => { listener = undefined }
      },
    }

    const catalog = await queryLocalCliDraftCommandCatalog('workspace-a', {
      client,
      command: { command: '/runtime/bun', argv: ['/runtime/cli.js'] },
      cwd: '/projects/proma',
      environment: { HOME: '/tmp/home' },
      sessionId: 'draft-catalog-session',
      nativeSessionId: '00000000-0000-4000-8000-000000000001',
      requestId: 'initialize-request',
      additionalSkillDirectories: ['/proma/workspace-skills'],
      timeoutMs: 1_000,
    })

    expect(catalog).toEqual({
      workspaceId: 'workspace-a',
      commands: [{ name: 'review', description: 'Review changes', argumentHint: '' }],
    })
    expect(requests.map((request) => request.method)).toEqual([
      'session.open',
      'session.control',
      'session.close',
    ])
    expect(requests.some((request) => request.method === 'session.send')).toBe(false)
    expect(requests[0]?.params.cwd).toBe('/projects/proma')
    expect(requests[0]?.params.cli).toMatchObject({ argv: expect.arrayContaining(['--catalog-only']) })
    expect(requests[0]?.params).not.toHaveProperty('resumeSessionId')
    expect(requests[1]?.params.payload).toEqual({
      additionalSkillDirectories: ['/proma/workspace-skills'],
    })
  })
})

describe('Local CLI context normalization', () => {
  test('Given get_context_usage 返回原生统计 When 归一化 Then 保留容量、分类与自动压缩状态', () => {
    expect(normalizeLocalCliContextUsage('session-context', {
      categories: [{ name: 'Messages', tokens: 1200, color: '#fff', isDeferred: false }],
      totalTokens: 1200,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 0.6,
      model: 'claude-sonnet-4',
      cacheHitRate: 0.72,
      cacheThreshold: 0.5,
      autoCompactThreshold: 167000,
      isAutoCompactEnabled: true,
      apiUsage: {
        input_tokens: 100,
        output_tokens: 30,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 50,
      },
    })).toEqual({
      sessionId: 'session-context',
      categories: [{ name: 'Messages', tokens: 1200, color: '#fff', isDeferred: false }],
      totalTokens: 1200,
      maxTokens: 200000,
      rawMaxTokens: 200000,
      percentage: 0.6,
      model: 'claude-sonnet-4',
      cacheHitRate: 0.72,
      cacheThreshold: 0.5,
      autoCompactThreshold: 167000,
      isAutoCompactEnabled: true,
      apiUsage: {
        inputTokens: 100,
        outputTokens: 30,
        cacheCreationTokens: 20,
        cacheReadTokens: 50,
      },
    })
  })

  test('Given context 响应缺少容量 When 归一化 Then 明确失败而不是伪造 0', () => {
    expect(() => normalizeLocalCliContextUsage('invalid-session', {
      categories: [], percentage: 0, model: 'test', isAutoCompactEnabled: true,
    })).toThrow('totalTokens')
  })
})

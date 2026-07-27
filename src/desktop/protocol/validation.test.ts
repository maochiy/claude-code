import { describe, expect, test } from 'bun:test'
import {
  DESKTOP_PROTOCOL_VERSION,
  type RuntimeCommand,
  type RuntimeEnvelope,
  type RuntimeEvent,
} from './types.js'
import { assertCommandEnvelope, assertEventEnvelope } from './validation.js'

function commandEnvelope(
  payload: RuntimeCommand,
  sessionId?: string,
): RuntimeEnvelope<RuntimeCommand> {
  return {
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    requestId: 'request-1',
    sessionId,
    timestamp: Date.now(),
    payload,
  }
}

function eventEnvelope(
  payload: RuntimeEvent,
  sessionId?: string,
): RuntimeEnvelope<RuntimeEvent> {
  return {
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    requestId: 'event-1',
    sessionId,
    timestamp: Date.now(),
    payload,
  }
}

describe('Desktop Runtime protocol validation', () => {
  test('接受当前协议版本的命令信封', () => {
    expect(() =>
      assertCommandEnvelope(commandEnvelope({ type: 'host.getCapabilities' })),
    ).not.toThrow()
  })

  test('拒绝协议版本不匹配', () => {
    const envelope = commandEnvelope({ type: 'host.getCapabilities' })
    envelope.protocolVersion += 1
    expect(() => assertCommandEnvelope(envelope)).toThrow('protocol 不兼容')
  })

  test('拒绝超过大小限制的消息', () => {
    const envelope = commandEnvelope(
      { type: 'turn.start', prompt: 'x'.repeat(8 * 1024 * 1024) },
      'session-1',
    )
    expect(() => assertCommandEnvelope(envelope)).toThrow('超过')
  })

  test('拒绝未知命令类型', () => {
    const envelope = commandEnvelope(
      { type: 'host.getCapabilities' },
      'session-1',
    ) as unknown as {
      protocolVersion: number
      requestId: string
      sessionId: string
      timestamp: number
      payload: { type: string }
    }
    envelope.payload = { type: 'unknown.command' }
    expect(() => assertCommandEnvelope(envelope)).toThrow(
      'Runtime command 不支持',
    )
  })

  test('拒绝缺少 Session ID 的 Turn 命令', () => {
    expect(() =>
      assertCommandEnvelope(
        commandEnvelope({ type: 'turn.start', prompt: 'hello' }),
      ),
    ).toThrow('sessionId')
  })

  test('拒绝缺少 prompt 的 Turn 命令', () => {
    const envelope = commandEnvelope(
      { type: 'turn.start', prompt: 'hello' },
      'session-1',
    ) as unknown as {
      protocolVersion: number
      requestId: string
      sessionId: string
      timestamp: number
      payload: { type: 'turn.start'; prompt?: string }
    }
    delete envelope.payload.prompt
    expect(() => assertCommandEnvelope(envelope)).toThrow('prompt')
  })

  test('拒绝非法 interaction response', () => {
    const envelope = commandEnvelope(
      {
        type: 'interaction.resolve',
        interactionId: 'interaction-1',
        response: { outcome: 'cancel' },
      },
      'session-1',
    ) as unknown as {
      protocolVersion: number
      requestId: string
      sessionId: string
      timestamp: number
      payload: {
        type: 'interaction.resolve'
        interactionId: string
        response: { outcome: string }
      }
    }
    envelope.payload.response = { outcome: 'unknown' }
    expect(() => assertCommandEnvelope(envelope)).toThrow('outcome 不支持')
  })

  test('接受合法的 Session 思考等级', () => {
    expect(() =>
      assertCommandEnvelope(
        commandEnvelope(
          { type: 'session.setEffortLevel', level: 'xhigh' },
          'session-1',
        ),
      ),
    ).not.toThrow()
  })

  test('接受合法的 Session Runtime 配置更新', () => {
    expect(() =>
      assertCommandEnvelope(
        commandEnvelope(
          {
            type: 'session.updateConfig',
            model: 'claude-opus-4-6',
            thinkingConfig: { type: 'adaptive' },
            effortLevel: 'max',
          },
          'session-1',
        ),
      ),
    ).not.toThrow()
  })

  test('拒绝非法的 Session 思考等级', () => {
    const envelope = commandEnvelope(
      { type: 'session.setEffortLevel', level: 'high' },
      'session-1',
    ) as unknown as {
      protocolVersion: number
      requestId: string
      sessionId: string
      timestamp: number
      payload: { type: 'session.setEffortLevel'; level: string }
    }
    envelope.payload.level = 'ultra'
    expect(() => assertCommandEnvelope(envelope)).toThrow('level 非法')
  })

  test('接受完整 runtime event', () => {
    expect(() =>
      assertEventEnvelope(
        eventEnvelope(
          {
            type: 'worker.crashed',
            exitCode: 1,
            signal: null,
            recoverable: false,
          },
          'session-1',
        ),
      ),
    ).not.toThrow()
  })

  test('拒绝畸形 runtime event', () => {
    const envelope = eventEnvelope(
      {
        type: 'worker.crashed',
        exitCode: 1,
        signal: null,
        recoverable: false,
      },
      'session-1',
    ) as unknown as {
      protocolVersion: number
      requestId: string
      sessionId: string
      timestamp: number
      payload: {
        type: 'worker.crashed'
        exitCode: number
        signal: null
        recoverable?: boolean
      }
    }
    delete envelope.payload.recoverable
    expect(() => assertEventEnvelope(envelope)).toThrow('recoverable')
  })
})

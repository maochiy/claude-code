import { describe, expect, test } from 'bun:test'
import {
  BrowserError,
  FrameDecoder,
  PROTOCOL,
  encodeFrame,
  errorEnvelope,
  requestEnvelope,
  responseEnvelope,
  validateMessage,
} from '../protocol.js'
import { captureSync } from './captureBrowserError.js'

describe('protocol', () => {
  test('encode/decode roundtrip preserves envelopes', () => {
    const request = requestEnvelope(
      'id-1',
      'tabs.attach',
      { tabId: 3 },
      {
        taskId: 'main',
        sessionId: 's1',
        sessionTitle: '标题',
      },
    )
    const decoder = new FrameDecoder()
    const messages = decoder.push(encodeFrame(request))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual(request)
  })

  test('decoder assembles frames split across chunks', () => {
    const frame = encodeFrame(responseEnvelope('id-2', { ok: 1 }))
    const decoder = new FrameDecoder()
    expect(decoder.push(frame.subarray(0, 2))).toHaveLength(0)
    expect(decoder.push(frame.subarray(2, 9))).toHaveLength(0)
    const messages = decoder.push(frame.subarray(9))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({
      protocol: PROTOCOL,
      type: 'response',
      id: 'id-2',
      ok: true,
      result: { ok: 1 },
    })
  })

  test('decoder handles multiple frames in one chunk', () => {
    const decoder = new FrameDecoder()
    const messages = decoder.push(
      Buffer.concat([
        encodeFrame(requestEnvelope('a', 'ping')),
        encodeFrame(requestEnvelope('b', 'tabs.list')),
      ]),
    )
    expect(
      messages.map(message => ('id' in message ? message.id : '')),
    ).toEqual(['a', 'b'])
  })

  test('oversized frames are rejected with MESSAGE_TOO_LARGE', () => {
    const decoder = new FrameDecoder({ maxBytes: 16 })
    expect(
      captureSync(() =>
        decoder.push(
          encodeFrame(requestEnvelope('big', 'ping', { pad: 'x'.repeat(64) })),
        ),
      ).code,
    ).toBe('MESSAGE_TOO_LARGE')
    expect(
      captureSync(() =>
        encodeFrame(
          requestEnvelope('big', 'ping', { pad: 'x'.repeat(9 * 1024 * 1024) }),
        ),
      ).code,
    ).toBe('MESSAGE_TOO_LARGE')
  })

  test('invalid frame JSON throws PROTOCOL_INVALID', () => {
    const decoder = new FrameDecoder()
    const payload = Buffer.from('not json')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(payload.length)
    expect(
      captureSync(() => decoder.push(Buffer.concat([header, payload]))).code,
    ).toBe('PROTOCOL_INVALID')
  })

  test('validateMessage rejects protocol mismatches and malformed envelopes', () => {
    expect(captureSync(() => validateMessage(null)).code).toBe(
      'PROTOCOL_INVALID',
    )
    expect(
      captureSync(() =>
        validateMessage({
          protocol: 'other/1',
          type: 'request',
          id: 'x',
          method: 'ping',
        }),
      ).code,
    ).toBe('PROTOCOL_UNSUPPORTED')
    expect(
      captureSync(() =>
        validateMessage({ protocol: PROTOCOL, type: 'wat', id: 'x' }),
      ).code,
    ).toBe('PROTOCOL_INVALID')
    expect(
      captureSync(() =>
        validateMessage({
          protocol: PROTOCOL,
          type: 'request',
          method: 'ping',
        }),
      ).code,
    ).toBe('PROTOCOL_INVALID')
    expect(
      captureSync(() =>
        validateMessage({ protocol: PROTOCOL, type: 'request', id: 'x' }),
      ).code,
    ).toBe('PROTOCOL_INVALID')
  })

  test('errorEnvelope serializes BrowserError with code and retryable', () => {
    const envelope = errorEnvelope(
      'id-3',
      new BrowserError('EXTENSION_OFFLINE', 'offline', { retryable: true }),
    )
    expect(envelope.ok).toBe(false)
    expect(envelope.error?.code).toBe('EXTENSION_OFFLINE')
    expect(envelope.error?.retryable).toBe(true)
  })

  test('errorEnvelope wraps unknown errors as INTERNAL_ERROR', () => {
    const envelope = errorEnvelope('id-4', new Error('boom'))
    expect(envelope.error?.code).toBe('INTERNAL_ERROR')
    expect(envelope.error?.retryable).toBe(false)
  })
})

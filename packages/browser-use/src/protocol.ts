/**
 * ccb-browser/1 帧协议：4 字节小端长度前缀 + JSON 信封。
 *
 * 信封形状（与 dsh-browser/1 兼容，仅协议名不同）：
 *   request  { protocol, type: 'request', id, method, params, taskId?, sessionId?, sessionTitle? }
 *   response { protocol, type: 'response', id, ok: true, result } | { ..., ok: false, error }
 *   event    { protocol, type: 'event', name, params? }（当前未使用）
 */

export const PROTOCOL = 'ccb-browser/1'
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

export type SerializedError = {
  code: string
  message: string
  retryable: boolean
  details: Record<string, unknown>
}

export class BrowserError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean
      details?: Record<string, unknown>
    } = {},
  ) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details ?? {}
  }

  toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    }
  }
}

export type RequestExtra = {
  taskId?: string | null
  sessionId?: string | null
  sessionTitle?: string | null
}

export type RequestEnvelope = {
  protocol: typeof PROTOCOL
  type: 'request'
  id: string
  method: string
  params: Record<string, unknown>
} & RequestExtra

export type ResponseEnvelope = {
  protocol: typeof PROTOCOL
  type: 'response'
  id: string
  ok: boolean
  result?: unknown
  error?: SerializedError
}

export type EventEnvelope = {
  protocol: typeof PROTOCOL
  type: 'event'
  name: string
  params?: unknown
}

export type ProtocolMessage = RequestEnvelope | ResponseEnvelope | EventEnvelope

export function requestEnvelope(
  id: string,
  method: string,
  params: Record<string, unknown> = {},
  extra: RequestExtra = {},
): RequestEnvelope {
  return {
    protocol: PROTOCOL,
    type: 'request',
    id,
    method,
    params,
    ...extra,
  }
}

export function responseEnvelope(
  id: string,
  result: unknown,
): ResponseEnvelope {
  return { protocol: PROTOCOL, type: 'response', id, ok: true, result }
}

export function errorEnvelope(id: string, error: unknown): ResponseEnvelope {
  const e =
    error instanceof BrowserError
      ? error
      : new BrowserError(
          'INTERNAL_ERROR',
          (error as Error | null)?.message || String(error),
        )
  return {
    protocol: PROTOCOL,
    type: 'response',
    id,
    ok: false,
    error: e.toJSON(),
  }
}

export function validateMessage(message: unknown): ProtocolMessage {
  if (!message || typeof message !== 'object') {
    throw new BrowserError('PROTOCOL_INVALID', 'Message must be an object')
  }
  const value = message as Record<string, unknown>
  if (value.protocol !== PROTOCOL) {
    throw new BrowserError(
      'PROTOCOL_UNSUPPORTED',
      'Unsupported browser protocol',
    )
  }
  if (
    value.type !== 'request' &&
    value.type !== 'response' &&
    value.type !== 'event'
  ) {
    throw new BrowserError('PROTOCOL_INVALID', 'Invalid message type')
  }
  if (value.type !== 'event' && (typeof value.id !== 'string' || !value.id)) {
    throw new BrowserError('PROTOCOL_INVALID', 'Message id is required')
  }
  if (
    value.type === 'request' &&
    (typeof value.method !== 'string' || !value.method)
  ) {
    throw new BrowserError('PROTOCOL_INVALID', 'Request method is required')
  }
  return value as ProtocolMessage
}

export function encodeFrame(
  message: ProtocolMessage,
  maxBytes = MAX_FRAME_BYTES,
): Buffer {
  const payload = Buffer.from(JSON.stringify(message))
  if (payload.length > maxBytes) {
    throw new BrowserError('MESSAGE_TOO_LARGE', 'Message exceeds size limit')
  }
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length)
  return Buffer.concat([header, payload])
}

export class FrameDecoder {
  readonly maxBytes: number
  private buffer: Buffer

  constructor(options: { maxBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? MAX_FRAME_BYTES
    this.buffer = Buffer.alloc(0)
  }

  push(chunk: Buffer | Uint8Array | string): ProtocolMessage[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk as Buffer)])
    const out: ProtocolMessage[] = []
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0)
      if (length > this.maxBytes) {
        throw new BrowserError('MESSAGE_TOO_LARGE', 'Frame exceeds size limit')
      }
      if (this.buffer.length < length + 4) break
      const raw = this.buffer.subarray(4, length + 4)
      this.buffer = this.buffer.subarray(length + 4)
      let value: unknown
      try {
        value = JSON.parse(raw.toString('utf-8'))
      } catch {
        throw new BrowserError('PROTOCOL_INVALID', 'Invalid frame JSON')
      }
      out.push(validateMessage(value))
    }
    return out
  }
}

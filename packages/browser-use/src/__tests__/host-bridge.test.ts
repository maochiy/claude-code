import { describe, expect, test } from 'bun:test'
import net from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserHostBridge } from '../host-bridge.js'
import {
  encodeFrame,
  FrameDecoder,
  requestEnvelope,
  responseEnvelope,
  type ProtocolMessage,
} from '../protocol.js'

function waitConnect(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', error => reject(error))
  })
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('BrowserHostBridge', () => {
  test('routes extension responses back to the originating client connection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccb-browser-bridge-'))
    const socketPath = join(dir, 'host.sock')
    const forwarded: ProtocolMessage[] = []
    const bridge = new BrowserHostBridge({
      socketPath,
      writeToExtension: frame => {
        for (const message of new FrameDecoder().push(frame)) {
          forwarded.push(message)
        }
      },
    })
    await bridge.start()

    const clientA = net.createConnection(socketPath)
    const clientB = net.createConnection(socketPath)
    const messagesA: ProtocolMessage[] = []
    const messagesB: ProtocolMessage[] = []
    const decoderA = new FrameDecoder()
    const decoderB = new FrameDecoder()
    try {
      await Promise.all([waitConnect(clientA), waitConnect(clientB)])
      clientA.on('data', chunk => {
        messagesA.push(...decoderA.push(chunk))
      })
      clientB.on('data', chunk => {
        messagesB.push(...decoderB.push(chunk))
      })

      clientA.write(
        encodeFrame(
          requestEnvelope('req-a', 'tabs.attach', {}, { sessionId: 'a' }),
        ),
      )
      clientB.write(
        encodeFrame(
          requestEnvelope('req-b', 'tabs.list', {}, { sessionId: 'b' }),
        ),
      )

      await waitFor(() => forwarded.length >= 2)
      // 转发给扩展的请求 id 带连接前缀，避免多 client 撞 id
      const ids = forwarded.map(message => ('id' in message ? message.id : ''))
      expect(ids).toContain('1:req-a')
      expect(ids).toContain('2:req-b')

      // 模拟扩展响应（乱序回复）
      bridge.handleExtensionData(
        encodeFrame(responseEnvelope('2:req-b', { tabs: [] })),
      )
      bridge.handleExtensionData(
        encodeFrame(responseEnvelope('1:req-a', { tabId: 7 })),
      )

      await waitFor(() => messagesA.length >= 1)
      const responseA = messagesA[0]
      expect(
        responseA && responseA.type === 'response' ? responseA.id : '',
      ).toBe('req-a')
      expect(
        responseA && responseA.type === 'response' ? responseA.result : null,
      ).toEqual({ tabId: 7 })
      await waitFor(() => messagesB.length >= 1)
      const responseB = messagesB[0]
      expect(
        responseB && responseB.type === 'response' ? responseB.id : '',
      ).toBe('req-b')
    } finally {
      clientA.destroy()
      clientB.destroy()
      await bridge.stop()
    }
  })

  test('extension ping is answered directly by the host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccb-browser-bridge-'))
    const socketPath = join(dir, 'host.sock')
    const replies: ProtocolMessage[] = []
    const bridge = new BrowserHostBridge({
      socketPath,
      writeToExtension: frame => {
        replies.push(...new FrameDecoder().push(frame))
      },
    })
    await bridge.start()
    try {
      bridge.handleExtensionData(encodeFrame(requestEnvelope('ping-1', 'ping')))
      await waitFor(() => replies.length >= 1)
      expect(
        replies[0] && replies[0].type === 'response' ? replies[0].result : null,
      ).toEqual({
        protocol: 'ccb-browser/1',
      })
    } finally {
      await bridge.stop()
    }
  })

  test('client disconnect cleans up routing entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccb-browser-bridge-'))
    const socketPath = join(dir, 'host.sock')
    const forwarded: ProtocolMessage[] = []
    const bridge = new BrowserHostBridge({
      socketPath,
      writeToExtension: frame => {
        forwarded.push(...new FrameDecoder().push(frame))
      },
    })
    await bridge.start()
    const client = net.createConnection(socketPath)
    try {
      await waitConnect(client)
      client.write(encodeFrame(requestEnvelope('req-1', 'tabs.list')))
      await waitFor(() => forwarded.length >= 1)
      client.destroy()
      await waitFor(() => bridge.clientCount === 0)
      // 连接关闭后，迟到的扩展响应被安全丢弃
      bridge.handleExtensionData(encodeFrame(responseEnvelope('1:req-1', {})))
      expect(bridge.clientCount).toBe(0)
    } finally {
      await bridge.stop()
    }
  })
})

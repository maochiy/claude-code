import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { HttpsProxyAgent } from 'https-proxy-agent'

/**
 * Node-http-layer fetch for proxied provider requests (chatgpt.com backend,
 * auth endpoints). Modeled on ZCode's provider transport: each request uses a
 * dedicated `HttpsProxyAgent`/`https.Agent` — no connection pooling — so a
 * socket killed by the proxy or server after idle can never be reused, which
 * is what caused intermittent "fetch failed (Client network socket
 * disconnected before secure TLS connection was established)".
 *
 * Works under both Node and Bun (both support node:http/https), and returns
 * a web `Response` wrapping the raw IncomingMessage so SSE parsing is
 * unchanged.
 */
export async function proxiedFetch(
  url: string,
  init: {
    body?: string
    headers?: Record<string, string>
    method?: string
    proxyUrl?: string
    signal?: AbortSignal | null
  },
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const transport = new URL(url).protocol === 'http:' ? http : https

    const signal = init.signal ?? undefined
    const abortError = (sig: AbortSignal | undefined): Error => {
      if (sig?.reason instanceof Error) return sig.reason
      const error = new Error('The operation was aborted.')
      error.name = 'AbortError'
      return error
    }
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }

    const agent = init.proxyUrl
      ? new HttpsProxyAgent(init.proxyUrl)
      : new https.Agent()

    let settled = false
    const rejectOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    }
    const onAbort = (): void => {
      const error = abortError(signal)
      request.destroy(error)
      rejectOnce(error)
    }

    const request = transport.request(
      url,
      {
        agent,
        headers: init.headers,
        method: init.method ?? 'POST',
      },
      message => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(message.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item)
          } else if (value !== undefined) {
            headers.append(name, String(value))
          }
        }
        settled = true
        resolve(
          new Response(
            Readable.toWeb(message) as unknown as ReadableStream<Uint8Array>,
            {
              headers,
              status: message.statusCode ?? 502,
              statusText: message.statusMessage,
            },
          ),
        )
      },
    )
    request.on('error', rejectOnce)
    signal?.addEventListener('abort', onAbort, { once: true })
    request.end(init.body)
  })
}

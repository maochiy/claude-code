import { afterEach, describe, expect, test } from 'bun:test'
import {
  startNativeInteractionsAnthropicServer,
  type NativeInteractionsAnthropicServer,
} from './fixtures/native-interactions-anthropic-server'

let server: NativeInteractionsAnthropicServer | undefined

afterEach(() => {
  server?.stop()
  server = undefined
})

async function sendScenario(baseUrl: string, content: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-native-interactions-fixture',
      stream: true,
      messages: [{ role: 'user', content }],
    }),
  })
  expect(response.status).toBe(200)
  return response.text()
}

describe('真实 UI 隔离 Provider fixture', () => {
  test('分段延迟正文并记录首个 SSE event 延迟', async () => {
    const firstEvents: number[] = []
    server = startNativeInteractionsAnthropicServer({
      eventDelayMs: 20,
      onFirstEvent: request => firstEvents.push(request.firstEventDelayMs ?? -1),
    })

    const startedAt = Date.now()
    const body = await sendScenario(server.baseUrl, 'NATIVE_INTERACTION_UI_TEXT')
    const elapsedMs = Date.now() - startedAt
    const textDeltaCount = body.match(/"type":"text_delta"/g)?.length ?? 0

    expect(textDeltaCount).toBeGreaterThan(2)
    expect(elapsedMs).toBeGreaterThanOrEqual(100)
    expect(firstEvents).toHaveLength(1)
    expect(firstEvents[0]).toBeGreaterThanOrEqual(15)
    expect(server.requests[0]?.firstEventAtMs).toBeNumber()

    const metrics = await fetch(`${server.baseUrl}/fixture/requests`).then(response => response.json())
    expect(metrics).toEqual([expect.objectContaining({
      scenario: 'NATIVE_INTERACTION_UI_TEXT',
      ordinal: 1,
      firstEventDelayMs: expect.any(Number),
    })])
    expect(JSON.stringify(metrics)).not.toContain('messages')
  })

  test('返回两个互相独立的后台 Bash 工具调用', async () => {
    server = startNativeInteractionsAnthropicServer()
    const projectPath = '/tmp/xcodes-native-ui-fixture-project'
    const body = await sendScenario(
      server.baseUrl,
      `NATIVE_INTERACTION_UI_BACKGROUND_TASKS TARGET_PATH=${projectPath}`,
    )

    expect(body.match(/"name":"Bash"/g)).toHaveLength(2)
    expect(body.match(/run_in_background/g)).toHaveLength(2)
    expect(body).toContain('background-task-a.txt')
    expect(body).toContain('background-task-b.txt')
  })
})


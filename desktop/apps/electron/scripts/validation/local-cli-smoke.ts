/** 隔离真实 CLI + 本地假模型：只在临时目录执行，不读取用户配置或访问外网。 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startLocalService } from '../../../local-service/src/server'
import { LocalServiceClient, type LocalServiceEvent } from '../../src/main/lib/local-service/client'

const cliRoot = process.env.XCODES_CLI_SOURCE_ROOT
if (!cliRoot) throw new Error('必须显式提供 XCODES_CLI_SOURCE_ROOT')
const fixture = mkdtempSync(join(tmpdir(), 'xcodes-native-cli-'))
const cwd = join(fixture, 'project')
const home = join(fixture, 'home')
mkdirSync(cwd); mkdirSync(home)
const frames = [
  { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 32, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '隔离测试' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成。' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 32, output_tokens: 8 } },
  { type: 'message_stop' },
]
let modelCalls = 0
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url)
  if (url.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 100 })
  if (!url.pathname.endsWith('/messages')) return Response.json({ error: 'fixture route only' }, { status: 404 })
  await request.json()
  modelCalls++
  return new Response(new ReadableStream({ async start(controller) {
    for (const frame of frames) {
      controller.enqueue(new TextEncoder().encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`))
      await Bun.sleep(15)
    }
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
} })
const token = randomUUID()
const service = startLocalService({ token, stateDir: join(fixture, 'service') })
const client = new LocalServiceClient(`http://127.0.0.1:${service.port}`, token)
const sessionId = randomUUID()
const events: LocalServiceEvent[] = []
client.subscribe((event) => { events.push(event) })
async function waitFor(predicate: (event: LocalServiceEvent) => boolean, timeout = 30_000): Promise<LocalServiceEvent> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const event = events.find(predicate)
    if (event) return event
    await Bun.sleep(20)
  }
  const summary = events.map(event => ({ kind: event.kind, payloadType: event.payload.type, subtype: event.payload.subtype, state: event.payload.state }))
  throw new Error(`等待 CLI 超时: ${JSON.stringify(summary)}`)
}
async function control(subtype: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const requestId = randomUUID()
  await client.request('session.control', { sessionId, requestId, subtype, payload })
  const event = await waitFor(event => event.kind === 'control_resolved' && event.requestId === requestId)
  const response = event.payload.response as { subtype?: string; error?: string; response?: Record<string, unknown> }
  if (response.subtype !== 'success') throw new Error(`${subtype}: ${response.error || '控制失败'}`)
  return response.response ?? {}
}
try {
  await client.connect()
  await client.request('session.open', {
    sessionId, cwd, permissionMode: 'default', model: 'claude-sonnet-4-6',
    cli: { command: process.execPath, argv: [resolve(cliRoot, 'dist/cli-bun.js'), '--bare'], env: {
      PATH: process.env.PATH || '', HOME: home, USERPROFILE: home, SHELL: '/bin/sh',
      CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      ANTHROPIC_API_KEY: 'isolated-fixture-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.port}`,
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    } },
  })
  const initialized = await control('initialize')
  await control('set_effort', { effort: 'low' })
  await control('set_effort', { effort: null })
  const disabled = await control('set_auto_compact', { enabled: false })
  if (disabled.enabled !== false) throw new Error('自动压缩实际状态错误')
  const requestId = randomUUID(); const started = Date.now()
  await client.request('session.send', { sessionId, requestId, content: '只回复隔离测试完成，不调用工具。' })
  const first = await waitFor(event => event.kind === 'cli_message' && event.payload.type === 'stream_event')
  const result = await waitFor(event => event.kind === 'cli_message' && event.payload.type === 'result')
  if (result.payload.is_error === true) throw new Error('CLI 执行返回错误')
  if (first.timestamp >= result.timestamp) throw new Error('增量被整轮缓冲')
  const context = await control('get_context_usage')
  const report = {
    fixture, modelCalls, commands: Array.isArray(initialized.commands) ? initialized.commands.length : null,
    firstEventMs: first.timestamp - started, resultMs: result.timestamp - started,
    streamedEvents: events.filter(event => event.kind === 'cli_message' && event.payload.type === 'stream_event').length,
    contextCategories: Array.isArray(context.categories) ? context.categories.length : null,
    autoCompactEnabled: context.isAutoCompactEnabled,
  }
  writeFileSync(join(fixture, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  client.dispose()
  await service.shutdown()
  provider.stop(true)
}

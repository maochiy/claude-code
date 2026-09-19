import { startNativeInteractionsAnthropicServer } from './native-interactions-anthropic-server'

const DEFAULT_EVENT_DELAY_MS = 140

function parseEventDelay(argv: string[]): number {
  const argument = argv.find(value => value.startsWith('--event-delay-ms='))
  if (!argument) return DEFAULT_EVENT_DELAY_MS
  const value = Number(argument.slice('--event-delay-ms='.length))
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('event-delay-ms 必须是非负数')
  }
  return value
}

const server = startNativeInteractionsAnthropicServer({
  eventDelayMs: parseEventDelay(process.argv.slice(2)),
  onFirstEvent(request) {
    console.log(`NATIVE_UI_FIRST_EVENT=${JSON.stringify({
      scenario: request.scenario,
      ordinal: request.ordinal,
      receivedAtMs: request.receivedAtMs,
      firstEventAtMs: request.firstEventAtMs,
      firstEventDelayMs: request.firstEventDelayMs,
    })}`)
  },
})

console.log(`NATIVE_UI_SERVER_READY=${JSON.stringify({
  baseUrl: server.baseUrl,
  requestsUrl: `${server.baseUrl}/fixture/requests`,
})}`)

let stopping = false
function stop(): void {
  if (stopping) return
  stopping = true
  server.stop()
  process.exit(0)
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)


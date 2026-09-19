import type { CliLaunchSpec } from '@proma/desktop-protocol'
import { startLocalService } from './server.ts'

export { startLocalService } from './server.ts'
export type {
  LocalServiceHandle,
  LocalServiceOptions,
} from './server.ts'

function parseStringMap(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined
  const parsed: unknown = JSON.parse(value)
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== 'object' ||
    !Object.values(parsed).every(item => typeof item === 'string')
  ) {
    throw new Error('XCODES_CLI_ENV_JSON must be a string map')
  }
  return parsed as Record<string, string>
}

function parseStringArray(value: string | undefined): string[] {
  if (!value) return []
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw new Error('XCODES_CLI_ARGV_JSON must be a string array')
  }
  return parsed
}

function cliFromEnvironment(): CliLaunchSpec | undefined {
  const command = process.env.XCODES_CLI_COMMAND
  if (!command) return undefined
  return {
    command,
    argv: parseStringArray(process.env.XCODES_CLI_ARGV_JSON),
    ...(process.env.XCODES_CLI_ENV_JSON
      ? { env: parseStringMap(process.env.XCODES_CLI_ENV_JSON) }
      : {}),
  }
}

if (import.meta.main) {
  const token = process.env.XCODES_LOCAL_SERVICE_TOKEN
  if (!token) {
    process.stderr.write('XCODES_LOCAL_SERVICE_TOKEN is required\n')
    process.exit(1)
  }
  const requestedPort = Number(process.env.XCODES_LOCAL_SERVICE_PORT ?? '0')
  const service = startLocalService({
    token,
    port: Number.isFinite(requestedPort) ? requestedPort : 0,
    defaultCli: cliFromEnvironment(),
    stateDir: process.env.XCODES_LOCAL_SERVICE_STATE_DIR,
  })
  process.stdout.write(`${JSON.stringify(service.ready)}\n`)

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await service.shutdown()
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
}

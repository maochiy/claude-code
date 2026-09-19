import {
  type CliLaunchSpec,
  type JsonValue,
  type PermissionMode,
  type RpcRequest,
  type RpcResponse,
  rpcFailure,
  rpcSuccess,
} from '@proma/desktop-protocol'
import { ServiceError, errorMessage } from './errors.ts'
import type { SessionManager } from './session-manager.ts'

interface RpcHandlerOptions {
  manager: SessionManager
  startedAt: number
  serviceVersion: string
  shutdown: () => Promise<void>
}

function objectParams(request: RpcRequest): Record<string, JsonValue> {
  if (
    request.params === undefined ||
    request.params === null ||
    Array.isArray(request.params) ||
    typeof request.params !== 'object'
  ) {
    return {}
  }
  return request.params
}

function requiredString(
  params: Record<string, JsonValue>,
  key: string,
): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ServiceError('INVALID_PARAMS', `缺少字符串参数：${key}`)
  }
  return value
}

function optionalString(
  params: Record<string, JsonValue>,
  key: string,
): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new ServiceError('INVALID_PARAMS', `参数必须是字符串：${key}`)
  }
  return value
}

function optionalNumber(
  params: Record<string, JsonValue>,
  key: string,
): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ServiceError('INVALID_PARAMS', `参数必须是数字：${key}`)
  }
  return value
}

function optionalBoolean(
  params: Record<string, JsonValue>,
  key: string,
): boolean | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new ServiceError('INVALID_PARAMS', `参数必须是布尔值：${key}`)
  }
  return value
}

function parseCli(value: JsonValue | undefined): CliLaunchSpec | undefined {
  if (value === undefined) return undefined
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new ServiceError('INVALID_PARAMS', 'cli 必须是对象')
  }
  const command = value.command
  const argv = value.argv
  const env = value.env
  if (
    typeof command !== 'string' ||
    !Array.isArray(argv) ||
    !argv.every(item => typeof item === 'string')
  ) {
    throw new ServiceError('INVALID_PARAMS', 'cli.command/cli.argv 无效')
  }
  let parsedEnv: Record<string, string> | undefined
  if (env !== undefined) {
    if (
      env === null ||
      Array.isArray(env) ||
      typeof env !== 'object' ||
      !Object.values(env).every(item => typeof item === 'string')
    ) {
      throw new ServiceError('INVALID_PARAMS', 'cli.env 必须是字符串映射')
    }
    parsedEnv = env as Record<string, string>
  }
  return { command, argv: argv as string[], ...(parsedEnv ? { env: parsedEnv } : {}) }
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue
}

export async function handleRpc(
  request: RpcRequest,
  options: RpcHandlerOptions,
): Promise<RpcResponse> {
  try {
    const params = objectParams(request)
    switch (request.method) {
      case 'service.health':
        return rpcSuccess(
          request.id,
          asJson({
            protocolVersion: 1,
            serviceVersion: options.serviceVersion,
            uptimeMs: Date.now() - options.startedAt,
            sessions: options.manager.size,
            shuttingDown: options.manager.isShuttingDown,
            capabilities: [
              'session',
              'control',
              'replay',
              'tasks',
              'task-output',
              'snapshot',
            ],
          }),
        )
      case 'service.shutdown':
        queueMicrotask(() => void options.shutdown())
        return rpcSuccess(request.id, { accepted: true })
      case 'session.open': {
        const permissionMode = optionalString(params, 'permissionMode') as
          | PermissionMode
          | undefined
        const result = await options.manager.open({
          sessionId: requiredString(params, 'sessionId'),
          ...(optionalString(params, 'nativeSessionId')
            ? { nativeSessionId: optionalString(params, 'nativeSessionId') }
            : {}),
          cwd: requiredString(params, 'cwd'),
          ...(optionalString(params, 'resumeSessionId')
            ? { resumeSessionId: optionalString(params, 'resumeSessionId') }
            : {}),
          ...(optionalString(params, 'resumeSessionAt')
            ? { resumeSessionAt: optionalString(params, 'resumeSessionAt') }
            : {}),
          ...(optionalBoolean(params, 'forkSession') === undefined
            ? {}
            : { forkSession: optionalBoolean(params, 'forkSession') }),
          ...(permissionMode ? { permissionMode } : {}),
          ...(optionalString(params, 'model')
            ? { model: optionalString(params, 'model') }
            : {}),
          ...(params.cli === undefined ? {} : { cli: parseCli(params.cli) }),
        })
        return rpcSuccess(request.id, asJson(result))
      }
      case 'session.close':
        return rpcSuccess(
          request.id,
          asJson(
            await options.manager.close(requiredString(params, 'sessionId')),
          ),
        )
      case 'session.list':
        return rpcSuccess(request.id, asJson(await options.manager.list()))
      case 'session.snapshot':
        return rpcSuccess(
          request.id,
          asJson(
            await options.manager.snapshot(
              requiredString(params, 'sessionId'),
              optionalNumber(params, 'afterSeq') ?? 0,
            ),
          ),
        )
      case 'session.send': {
        const content = params.content
        if (content === undefined) {
          throw new ServiceError('INVALID_PARAMS', '缺少参数：content')
        }
        return rpcSuccess(
          request.id,
          asJson(
            options.manager.send({
              sessionId: requiredString(params, 'sessionId'),
              requestId: requiredString(params, 'requestId'),
              ...(optionalString(params, 'runId')
                ? { runId: optionalString(params, 'runId') }
                : {}),
              content,
              ...(optionalBoolean(params, 'interrupt') === undefined
                ? {}
                : { interrupt: optionalBoolean(params, 'interrupt') }),
              ...(optionalString(params, 'priority')
                ? {
                    priority: optionalString(params, 'priority') as
                      | 'now'
                      | 'next'
                      | 'later',
                  }
                : {}),
            }),
          ),
        )
      }
      case 'session.interrupt':
        return rpcSuccess(
          request.id,
          asJson(
            options.manager.interrupt({
              sessionId: requiredString(params, 'sessionId'),
              requestId: requiredString(params, 'requestId'),
              ...(optionalString(params, 'runId')
                ? { runId: optionalString(params, 'runId') }
                : {}),
            }),
          ),
        )
      case 'session.control': {
        const payload = params.payload
        if (
          payload !== undefined &&
          (payload === null ||
            Array.isArray(payload) ||
            typeof payload !== 'object')
        ) {
          throw new ServiceError('INVALID_PARAMS', 'payload 必须是对象')
        }
        return rpcSuccess(
          request.id,
          asJson(
            options.manager.control({
              sessionId: requiredString(params, 'sessionId'),
              requestId: requiredString(params, 'requestId'),
              subtype: requiredString(params, 'subtype'),
              ...(payload === undefined
                ? {}
                : { payload: payload as Record<string, JsonValue> }),
            }),
          ),
        )
      }
      case 'session.respond': {
        const response = params.response
        if (
          response !== undefined &&
          (response === null ||
            Array.isArray(response) ||
            typeof response !== 'object')
        ) {
          throw new ServiceError('INVALID_PARAMS', 'response 必须是对象')
        }
        return rpcSuccess(
          request.id,
          asJson(
            options.manager.respond({
              sessionId: requiredString(params, 'sessionId'),
              requestId: requiredString(params, 'requestId'),
              cliRequestId: requiredString(params, 'cliRequestId'),
              ...(response === undefined
                ? {}
                : { response: response as Record<string, JsonValue> }),
              ...(optionalString(params, 'error')
                ? { error: optionalString(params, 'error') }
                : {}),
            }),
          ),
        )
      }
      case 'task.stop':
        return rpcSuccess(
          request.id,
          asJson(
            options.manager.stopTask(
              requiredString(params, 'sessionId'),
              requiredString(params, 'taskId'),
              requiredString(params, 'requestId'),
            ),
          ),
        )
      case 'task.output':
        return rpcSuccess(
          request.id,
          asJson(
            await options.manager.readTaskOutput(
              requiredString(params, 'sessionId'),
              requiredString(params, 'taskId'),
              optionalNumber(params, 'offset'),
              optionalNumber(params, 'limit'),
            ),
          ),
        )
    }
  } catch (error) {
    if (error instanceof ServiceError) {
      return rpcFailure(request.id, error.code, error.message, error.details)
    }
    return rpcFailure(request.id, 'INTERNAL_ERROR', errorMessage(error))
  }
}

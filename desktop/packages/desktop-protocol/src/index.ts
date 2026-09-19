export const DESKTOP_PROTOCOL_VERSION = 1 as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

export type SessionProcessState =
  | 'starting'
  | 'ready'
  | 'running'
  | 'requires_action'
  | 'idle'
  | 'stopping'
  | 'stopped'
  | 'crashed'

export type SessionRunState =
  | 'queued'
  | 'running'
  | 'requires_action'
  | 'background'
  | 'completed'
  | 'failed'
  | 'interrupted'

export type BackgroundTaskState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'

export interface CliLaunchSpec {
  command: string
  argv: string[]
  env?: Record<string, string>
}

export interface SessionOpenParams {
  sessionId: string
  nativeSessionId?: string
  cwd: string
  resumeSessionId?: string
  resumeSessionAt?: string
  forkSession?: boolean
  permissionMode?: PermissionMode
  model?: string
  cli?: CliLaunchSpec
}

export interface SessionSendParams {
  sessionId: string
  requestId: string
  runId?: string
  content: JsonValue
  priority?: 'now' | 'next' | 'later'
  interrupt?: boolean
}

export interface SessionInterruptParams {
  sessionId: string
  requestId: string
  runId?: string
}

export interface SessionControlParams {
  sessionId: string
  requestId: string
  subtype: string
  payload?: Record<string, JsonValue>
}

export interface SessionRespondParams {
  sessionId: string
  requestId: string
  cliRequestId: string
  response?: Record<string, JsonValue>
  error?: string
}

export interface SessionIdParams {
  sessionId: string
}

export interface SessionSnapshotParams extends SessionIdParams {
  afterSeq?: number
}

export interface TaskStopParams extends SessionIdParams {
  requestId: string
  taskId: string
}

export interface TaskOutputParams extends SessionIdParams {
  taskId: string
  offset?: number
  limit?: number
}

export interface ServiceHealthResult {
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION
  serviceVersion: string
  uptimeMs: number
  sessions: number
  shuttingDown: boolean
}

export interface SessionOpenResult {
  sessionId: string
  generation: number
  pid: number | null
  state: SessionProcessState
}

/** WebSocket 断线续传游标。每个桌面会话独立记录 CLI 进程代次和事件序号。 */
export interface SessionEventCursor {
  generation: number
  seq: number
}

export interface SessionEventCursors {
  [sessionId: string]: SessionEventCursor
}

export interface AcceptedResult {
  accepted: true
  requestId: string
  runId?: string
}

export interface BackgroundTaskSnapshot {
  taskId: string
  toolUseId?: string
  state: BackgroundTaskState
  description?: string
  summary?: string
  outputFile?: string
  usage?: JsonValue
  updatedAt: number
}

export interface PendingControlSnapshot {
  cliRequestId: string
  subtype: string
  request: JsonValue
  createdAt: number
}

export interface SessionSnapshot {
  sessionId: string
  generation: number
  seq: number
  state: SessionProcessState
  cwd: string
  pid: number | null
  activeRunId?: string
  pendingControls: PendingControlSnapshot[]
  tasks: BackgroundTaskSnapshot[]
  events: DesktopEvent[]
  replay: ReplayMetadata
}

export interface ReplayMetadata {
  requestedAfterSeq: number
  oldestAvailableSeq: number
  currentSeq: number
  truncated: boolean
}

export interface TaskOutputResult {
  taskId: string
  offset: number
  nextOffset: number
  eof: boolean
  content: string
}

export type RpcMethod =
  | 'service.health'
  | 'service.shutdown'
  | 'session.open'
  | 'session.close'
  | 'session.list'
  | 'session.snapshot'
  | 'session.send'
  | 'session.interrupt'
  | 'session.control'
  | 'session.respond'
  | 'task.stop'
  | 'task.output'

export interface RpcRequest {
  id: string
  method: RpcMethod
  params?: JsonValue
}

export interface RpcError {
  code: string
  message: string
  details?: JsonValue
}

export interface RpcSuccess {
  id: string
  ok: true
  result: JsonValue
}

export interface RpcFailure {
  id: string
  ok: false
  error: RpcError
}

export type RpcResponse = RpcSuccess | RpcFailure

export type DesktopEventKind =
  | 'process_state'
  | 'run_state'
  | 'cli_message'
  | 'cli_stderr'
  | 'control_pending'
  | 'control_resolved'
  | 'task_state'
  | 'replay_reset'
  | 'service_error'

export interface DesktopEvent {
  type: 'desktop_event'
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION
  eventId: string
  sessionId: string
  generation: number
  seq: number
  timestamp: number
  source: 'service' | 'cli'
  kind: DesktopEventKind
  runId?: string
  requestId?: string
  payload: JsonValue
}

export interface LocalServiceReady {
  type: 'local_service_ready'
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION
  host: '127.0.0.1'
  port: number
}

export const RPC_METHODS: ReadonlySet<string> = new Set<RpcMethod>([
  'service.health',
  'service.shutdown',
  'session.open',
  'session.close',
  'session.list',
  'session.snapshot',
  'session.send',
  'session.interrupt',
  'session.control',
  'session.respond',
  'task.stop',
  'task.output',
])

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}

export function parseRpcRequest(value: unknown): RpcRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.method !== 'string' ||
    !RPC_METHODS.has(record.method) ||
    (record.params !== undefined && !isJsonValue(record.params))
  ) {
    return null
  }
  return {
    id: record.id,
    method: record.method as RpcMethod,
    ...(record.params === undefined ? {} : { params: record.params }),
  }
}

export function rpcSuccess(id: string, result: JsonValue): RpcSuccess {
  return { id, ok: true, result }
}

export function rpcFailure(
  id: string,
  code: string,
  message: string,
  details?: JsonValue,
): RpcFailure {
  return {
    id,
    ok: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  }
}

import type {
  LocalCliCommandCatalog,
  LocalCliContextCategory,
  LocalCliContextUsage,
  LocalCliDraftCommandCatalog,
  LocalCliDraftCommandCatalogInput,
  LocalCliSetAutoCompactInput,
  LocalCliSetAutoCompactResult,
  LocalCliSlashCommand,
} from '@proma/shared'
import { randomUUID } from 'node:crypto'
import { getAgentWorkspace } from '../agent-workspace-manager'
import { getWorkspaceSkillsDir } from '../config-paths'
import { getCcbUserConfigDir } from '../ccb-runtime/user-config'
import { buildCcbHostEnvironment } from '../ccb-runtime/runtime-security'
import type { LocalServiceClient, LocalServiceEvent } from './client'
import { parseLocalCliControlResolution } from './control-response'

const DRAFT_CATALOG_CACHE_TTL_MS = 15_000

interface DraftCatalogCacheEntry {
  expiresAt: number
  value: Promise<LocalCliDraftCommandCatalog>
}

interface DraftCatalogQueryOptions {
  client: Pick<LocalServiceClient, 'request' | 'subscribe'>
  command: { command: string; argv: string[] }
  cwd: string
  environment: Record<string, string>
  sessionId: string
  nativeSessionId: string
  requestId: string
  additionalSkillDirectories?: string[]
  timeoutMs?: number
}

const draftCatalogCache = new Map<string, DraftCatalogCacheEntry>()

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requiredFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Local CLI 上下文响应缺少有效字段：${field}`)
  }
  return value
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Local CLI 上下文响应缺少有效字段：${field}`)
  }
  return value
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Local CLI 上下文响应缺少有效字段：${field}`)
  }
  return value
}

function normalizeCommand(value: unknown): LocalCliSlashCommand | undefined {
  if (typeof value === 'string') {
    const name = value.trim().replace(/^\/+/, '')
    return name ? { name, description: '', argumentHint: '' } : undefined
  }
  const command = asRecord(value)
  if (!command) return undefined
  const rawName = typeof command.name === 'string'
    ? command.name
    : typeof command.command === 'string'
      ? command.command
      : undefined
  const name = rawName?.trim().replace(/^\/+/, '')
  if (!name) return undefined
  return {
    name,
    description: typeof command.description === 'string' ? command.description : '',
    argumentHint: typeof command.argumentHint === 'string'
      ? command.argumentHint
      : typeof command.argument_hint === 'string'
        ? command.argument_hint
        : '',
  }
}

/** 只投影 CLI 实际返回的命令；不在桌面层补写固定命令列表。 */
export function normalizeLocalCliCommandCatalog(
  sessionId: string,
  raw: unknown,
): LocalCliCommandCatalog {
  const catalog = asRecord(raw) ?? {}
  if (!Array.isArray(catalog.commands) && !Array.isArray(catalog.supported_commands)) {
    throw new Error('Local CLI initialize 响应缺少命令目录')
  }
  const rawCommands = Array.isArray(catalog.commands)
    ? catalog.commands
    : Array.isArray(catalog.supported_commands)
      ? catalog.supported_commands
      : []
  const commands: LocalCliSlashCommand[] = []
  const seen = new Set<string>()
  for (const value of rawCommands) {
    const command = normalizeCommand(value)
    if (!command || seen.has(command.name)) continue
    seen.add(command.name)
    commands.push(command)
  }
  return { sessionId, commands }
}

/**
 * 在临时 CLI 进程上只执行 initialize，读取完成后立即关闭。
 * 该路径不创建 Proma Session、worktree，也不会写入用户消息或启动模型 Run。
 */
export async function queryLocalCliDraftCommandCatalog(
  workspaceId: string,
  options: DraftCatalogQueryOptions,
): Promise<LocalCliDraftCommandCatalog> {
  const timeoutMs = options.timeoutMs ?? 30_000
  let cancelResultWait = (): void => {}
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error('读取 Local CLI 命令目录超时'))
    }, timeoutMs)
    const settle = (
      callback: () => void,
    ): void => {
      clearTimeout(timeout)
      unsubscribe()
      callback()
    }
    const unsubscribe = options.client.subscribe((event: LocalServiceEvent) => {
      if (event.sessionId !== options.sessionId) return
      const resolution = parseLocalCliControlResolution(event)
      if (resolution?.requestId === options.requestId) {
        settle(() => resolution.error
          ? reject(resolution.error)
          : resolve(resolution.result ?? {}))
        return
      }
      if (
        event.kind === 'process_state'
        && ['crashed', 'exited', 'stopped'].includes(String(event.payload.state))
      ) {
        settle(() => reject(new Error(
          typeof event.payload.message === 'string'
            ? event.payload.message
            : 'Local CLI 在读取命令目录前退出',
        )))
      }
    })
    cancelResultWait = () => {
      clearTimeout(timeout)
      unsubscribe()
    }
  })

  try {
    await options.client.request('session.open', {
      sessionId: options.sessionId,
      nativeSessionId: options.nativeSessionId,
      cwd: options.cwd,
      permissionMode: 'default',
      cli: {
        command: options.command.command,
        argv: [...options.command.argv, '--catalog-only'],
        env: options.environment,
      },
    })
    await options.client.request('session.control', {
      sessionId: options.sessionId,
      requestId: options.requestId,
      subtype: 'initialize',
      payload: {
        additionalSkillDirectories: options.additionalSkillDirectories ?? [],
      },
    })
    const catalog = normalizeLocalCliCommandCatalog(options.sessionId, await result)
    return { workspaceId, commands: catalog.commands }
  } finally {
    cancelResultWait()
    await options.client.request('session.close', { sessionId: options.sessionId }).catch(() => {})
  }
}

/** 首页未创建 Session 前的只读目录入口。 */
export async function readLocalCliDraftCommandCatalog(
  input: LocalCliDraftCommandCatalogInput,
): Promise<LocalCliDraftCommandCatalog> {
  const workspace = getAgentWorkspace(input.workspaceId)
  if (!workspace) throw new Error('项目不存在，请重新选择项目')

  const now = Date.now()
  const cacheKey = `${workspace.id}:${workspace.updatedAt}`
  const cached = draftCatalogCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.value

  const value = (async (): Promise<LocalCliDraftCommandCatalog> => {
    // Supervisor 依赖 Electron app，只在真实 IPC 请求时加载，保持归一化/协议测试可独立运行。
    const { localServiceSupervisor } = await import('./supervisor')
    const client = await localServiceSupervisor.getClient()
    const environment = buildCcbHostEnvironment(process.env)
    environment.CLAUDE_CONFIG_DIR = getCcbUserConfigDir()
    return queryLocalCliDraftCommandCatalog(input.workspaceId, {
      client,
      command: localServiceSupervisor.getCliCommand(),
      cwd: workspace.canonicalPath || workspace.path,
      environment,
      sessionId: `draft-catalog-${randomUUID()}`,
      nativeSessionId: randomUUID(),
      requestId: randomUUID(),
      additionalSkillDirectories: [getWorkspaceSkillsDir(workspace.slug)],
    })
  })()
  draftCatalogCache.set(cacheKey, {
    expiresAt: now + DRAFT_CATALOG_CACHE_TTL_MS,
    value,
  })
  void value.catch(() => {
    if (draftCatalogCache.get(cacheKey)?.value === value) {
      draftCatalogCache.delete(cacheKey)
    }
  })
  return value
}

function normalizeCategory(value: unknown): LocalCliContextCategory {
  const category = asRecord(value)
  if (!category || typeof category.name !== 'string') {
    throw new Error('Local CLI 上下文响应包含无效分类')
  }
  return {
    name: category.name,
    tokens: requiredFiniteNumber(category.tokens, `categories.${category.name}.tokens`),
    color: typeof category.color === 'string' ? category.color : '',
    ...(typeof category.isDeferred === 'boolean'
      ? { isDeferred: category.isDeferred }
      : {}),
  }
}

export function normalizeLocalCliContextUsage(
  sessionId: string,
  raw: unknown,
): LocalCliContextUsage {
  const context = asRecord(raw) ?? {}
  if (!Array.isArray(context.categories)) {
    throw new Error('Local CLI 上下文响应缺少有效字段：categories')
  }
  const categories = context.categories.map(normalizeCategory)
  const apiUsage = context.apiUsage === null
    ? null
    : (() => {
        const usage = asRecord(context.apiUsage)
        if (!usage) return undefined
        return {
          inputTokens: requiredFiniteNumber(usage.input_tokens ?? usage.inputTokens, 'apiUsage.inputTokens'),
          outputTokens: requiredFiniteNumber(usage.output_tokens ?? usage.outputTokens, 'apiUsage.outputTokens'),
          cacheCreationTokens: requiredFiniteNumber(
            usage.cache_creation_input_tokens ?? usage.cacheCreationTokens,
            'apiUsage.cacheCreationTokens',
          ),
          cacheReadTokens: requiredFiniteNumber(
            usage.cache_read_input_tokens ?? usage.cacheReadTokens,
            'apiUsage.cacheReadTokens',
          ),
        }
      })()
  return {
    sessionId,
    categories,
    totalTokens: requiredFiniteNumber(context.totalTokens, 'totalTokens'),
    maxTokens: requiredFiniteNumber(context.maxTokens, 'maxTokens'),
    rawMaxTokens: requiredFiniteNumber(context.rawMaxTokens, 'rawMaxTokens'),
    percentage: requiredFiniteNumber(context.percentage, 'percentage'),
    model: requiredString(context.model, 'model'),
    ...(typeof context.estimated === 'boolean' ? { estimated: context.estimated } : {}),
    ...(typeof context.cacheHitRate === 'number' && Number.isFinite(context.cacheHitRate)
      ? { cacheHitRate: context.cacheHitRate }
      : {}),
    ...(typeof context.cacheThreshold === 'number' && Number.isFinite(context.cacheThreshold)
      ? { cacheThreshold: context.cacheThreshold }
      : {}),
    ...(typeof context.autoCompactThreshold === 'number'
      && Number.isFinite(context.autoCompactThreshold)
      ? { autoCompactThreshold: context.autoCompactThreshold }
      : {}),
    isAutoCompactEnabled: requiredBoolean(context.isAutoCompactEnabled, 'isAutoCompactEnabled'),
    ...(apiUsage !== undefined ? { apiUsage } : {}),
  }
}

export async function readLocalCliSessionCatalog(
  sessionId: string,
): Promise<LocalCliCommandCatalog> {
  const { getLocalSessionCatalog } = await import('../agent-service')
  return normalizeLocalCliCommandCatalog(sessionId, await getLocalSessionCatalog(sessionId))
}

export async function readLocalCliSessionContext(
  sessionId: string,
  options: { prepareIfNeeded?: boolean } = {},
): Promise<LocalCliContextUsage> {
  const { getLocalSessionContext } = await import('../agent-service')
  return normalizeLocalCliContextUsage(
    sessionId,
    await getLocalSessionContext(sessionId, options),
  )
}

export async function updateLocalCliSessionAutoCompact(
  input: LocalCliSetAutoCompactInput,
): Promise<LocalCliSetAutoCompactResult> {
  const { setLocalSessionAutoCompact } = await import('../agent-service')
  await setLocalSessionAutoCompact(input.sessionId, input.enabled)
  const context = await readLocalCliSessionContext(input.sessionId)
  return { sessionId: input.sessionId, enabled: context.isAutoCompactEnabled }
}

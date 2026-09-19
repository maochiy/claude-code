/** Local CLI session controls exposed to the renderer through typed IPC. */

export const LOCAL_CLI_CONTROL_IPC_CHANNELS = {
  GET_CONTEXT: 'local-cli-control:get-context',
  GET_CATALOG: 'local-cli-control:get-catalog',
  GET_DRAFT_CATALOG: 'local-cli-control:get-draft-catalog',
  SET_AUTO_COMPACT: 'local-cli-control:set-auto-compact',
} as const

export interface LocalCliContextCategory {
  name: string
  tokens: number
  color: string
  isDeferred?: boolean
}

export interface LocalCliContextUsage {
  sessionId: string
  categories: LocalCliContextCategory[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  model: string
  estimated?: boolean
  cacheHitRate?: number
  cacheThreshold?: number
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
  apiUsage?: {
    inputTokens: number
    outputTokens: number
    cacheCreationTokens: number
    cacheReadTokens: number
  } | null
}

/**
 * 读取会话上下文用量。
 *
 * 默认只读取已经连接的 Runtime，避免仅查看历史会话时隐式启动 CLI。
 * 只有用户明确刷新详情时才设置 prepareIfNeeded。
 */
export interface LocalCliContextUsageInput {
  sessionId: string
  prepareIfNeeded?: boolean
}

export interface LocalCliSlashCommand {
  name: string
  description: string
  argumentHint: string
}

export interface LocalCliCommandCatalog {
  sessionId: string
  commands: LocalCliSlashCommand[]
}

/** 新建页尚无 Session 时，只按现有项目目录读取 CLI initialize 命令目录。 */
export interface LocalCliDraftCommandCatalogInput {
  workspaceId: string
}

export interface LocalCliDraftCommandCatalog {
  workspaceId: string
  commands: LocalCliSlashCommand[]
}

export interface LocalCliSetAutoCompactInput {
  sessionId: string
  enabled: boolean
}

export interface LocalCliSetAutoCompactResult {
  sessionId: string
  enabled: boolean
}

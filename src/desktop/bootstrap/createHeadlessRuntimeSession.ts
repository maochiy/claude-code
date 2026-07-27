import { randomUUID, type UUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import { QueryEngine } from '../../QueryEngine.js'
import { getCommands } from '../../commands.js'
import { initBuiltinPlugins } from '../../plugins/bundled/index.js'
import { setChatGPTCredentialsUpdateHandler } from '../../services/api/openai/chatgptAuth.js'
import { clearOpenAIClientCache } from '../../services/api/openai/client.js'
import { getMcpToolsCommandsAndResources } from '../../services/mcp/client.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import { initBundledSkills } from '../../skills/bundled/index.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import { createStore } from '../../state/store.js'
import {
  getEmptyToolPermissionContext,
  type Tool,
  type Tools,
} from '../../Tool.js'
import { getTools } from '../../tools.js'
import type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDenyDecision,
  PermissionMode,
} from '../../types/permissions.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { enableConfigs } from '../../utils/config.js'
import { FileStateCache } from '../../utils/fileStateCache.js'
import { applySafeConfigEnvironmentVariables } from '../../utils/managedEnv.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { loadConversationForResume } from '../../utils/conversationRecovery.js'
import {
  restoreSessionStateFromLog,
  restoreWorktreeForResume,
} from '../../utils/sessionRestore.js'
import {
  adoptResumedSessionFile,
  resetSessionFilePointer,
  restoreSessionMetadata,
} from '../../utils/sessionStorage.js'
import { setOriginalCwd, switchSession } from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import type { EffortLevel } from '../../utils/effort.js'
import { getAgentDefinitionsWithOverrides } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { ClaudeCodeDesktopHostBridge } from '../bridge/DesktopHostBridge.js'
import type {
  DesktopPermissionMode,
  RuntimeInteractionResponse,
  RuntimeSessionOptions,
} from '../protocol/types.js'

let injectedEnvironmentKeys = new Set<string>()

export interface HeadlessRuntimeSession {
  readonly runtimeSessionId: string
  submit(prompt: string, uuid?: string): AsyncIterable<SDKMessage>
  interrupt(): void
  resetAfterInterrupt(): void
  setPermissionMode(mode: DesktopPermissionMode): void
  setModel(model: string): void
  setThinkingConfig(
    thinkingConfig: RuntimeSessionOptions['thinkingConfig'],
  ): void
  setEffortLevel(level: EffortLevel | undefined): void
  getMessages(): ReturnType<QueryEngine['getMessages']>
  getFileHistoryState(): AppState['fileHistory']
  dispose(): Promise<void>
}

function toPermissionDecision(
  response: RuntimeInteractionResponse,
  input: Record<string, unknown>,
  toolUseId: string,
): PermissionAllowDecision | PermissionDenyDecision {
  if (response.outcome === 'allow' || response.outcome === 'approvePlan') {
    return {
      behavior: 'allow',
      updatedInput:
        response.outcome === 'allow' ? (response.updatedInput ?? input) : input,
    }
  }
  if (response.outcome === 'answer') {
    return {
      behavior: 'allow',
      updatedInput: { ...input, answers: response.answers },
    }
  }
  return {
    behavior: 'deny',
    message:
      response.outcome === 'deny'
        ? (response.message ?? '用户拒绝了此操作')
        : '用户取消了此操作',
    decisionReason: { type: 'other', reason: 'Desktop host denied request' },
    toolUseID: toolUseId,
  }
}

async function connectMcpServers(
  configs: Record<string, unknown> | undefined,
): Promise<{
  clients: MCPServerConnection[]
  tools: Tools
  commands: Awaited<ReturnType<typeof getCommands>>
}> {
  const clients: MCPServerConnection[] = []
  const tools: Tool[] = []
  const commands: Awaited<ReturnType<typeof getCommands>> = []
  if (!configs || Object.keys(configs).length === 0)
    return { clients, tools, commands }

  await getMcpToolsCommandsAndResources(
    result => {
      clients.push(result.client)
      tools.push(...result.tools)
      commands.push(...result.commands)
    },
    configs as Record<string, ScopedMcpServerConfig>,
  )
  return { clients, tools, commands }
}

export async function createHeadlessRuntimeSession(
  options: RuntimeSessionOptions,
  bridge: ClaudeCodeDesktopHostBridge,
): Promise<HeadlessRuntimeSession> {
  enableConfigs()
  initBuiltinPlugins()
  initBundledSkills()

  for (const name of injectedEnvironmentKeys) delete process.env[name]
  injectedEnvironmentKeys = new Set(Object.keys(options.environment.variables))
  for (const [name, value] of Object.entries(options.environment.variables)) {
    process.env[name] = value
  }
  process.env.CLAUDE_CONFIG_DIR = options.environment.configDir
  process.env.CLAUDE_CODE_ENTRYPOINT = 'desktop-runtime'
  clearOpenAIClientCache()
  setChatGPTCredentialsUpdateHandler(credentials => {
    bridge.emitCredentialsUpdated(credentials)
  })

  const runtimeSessionId = options.runtimeSessionId ?? randomUUID()
  switchSession(runtimeSessionId as SessionId)
  setOriginalCwd(options.cwd)
  process.chdir(options.cwd)
  resetSettingsCache()
  applySafeConfigEnvironmentVariables()

  const permissionContext = getEmptyToolPermissionContext()
  permissionContext.mode = options.permissionMode as PermissionMode
  const baseTools = getTools(permissionContext)
  const [baseCommands, agentDefinitions, mcp, resumeResult] = await Promise.all(
    [
      getCommands(options.cwd),
      getAgentDefinitionsWithOverrides(options.cwd),
      connectMcpServers(options.mcpServers),
      options.resume && options.runtimeSessionId
        ? loadConversationForResume(options.runtimeSessionId, undefined)
        : Promise.resolve(null),
    ],
  )

  const appState: AppState = {
    ...getDefaultAppState(),
    effortValue: options.effortLevel,
    toolPermissionContext: permissionContext,
    mcp: {
      ...getDefaultAppState().mcp,
      clients: mcp.clients,
      tools: [...mcp.tools],
      commands: mcp.commands,
    },
    agentDefinitions,
  }
  const store = createStore(appState)
  if (resumeResult) {
    if (resumeResult.sessionId) {
      switchSession(
        resumeResult.sessionId as SessionId,
        resumeResult.fullPath ? dirname(resumeResult.fullPath) : null,
      )
      await resetSessionFilePointer()
    }
    restoreSessionStateFromLog(resumeResult, store.setState)
    restoreSessionMetadata(resumeResult)
    restoreWorktreeForResume(resumeResult.worktreeSession)
    adoptResumedSessionFile()
  }
  const effectiveCwd = process.cwd()

  const canUseTool: CanUseToolFn = async (
    tool,
    input,
    context,
    assistantMessage,
    toolUseId,
    forceDecision,
  ) => {
    if (forceDecision) return forceDecision
    if (tool.name === 'ExitPlanMode') {
      const response = await bridge.approvePlan({
        interactionId: randomUUID(),
        toolUseId,
        input,
      })
      return toPermissionDecision(response, input, toolUseId)
    }
    if (tool.name === 'AskUserQuestion') {
      const response = await bridge.askUser({
        interactionId: randomUUID(),
        toolUseId,
        input,
      })
      return toPermissionDecision(response, input, toolUseId)
    }
    const pipeline = await hasPermissionsToUseTool(
      tool,
      input,
      context,
      assistantMessage,
      toolUseId,
    )
    if (pipeline.behavior !== 'ask') return pipeline

    let response: RuntimeInteractionResponse
    response = await bridge.requestPermission({
      interactionId: randomUUID(),
      toolName: tool.name,
      toolUseId,
      input,
      suggestions: (pipeline as PermissionAskDecision).suggestions,
    })
    return toPermissionDecision(response, input, toolUseId)
  }

  const engine = new QueryEngine({
    cwd: effectiveCwd,
    tools: [...baseTools, ...mcp.tools],
    commands: [...baseCommands, ...mcp.commands],
    mcpClients: mcp.clients,
    agents: agentDefinitions.activeAgents,
    canUseTool,
    getAppState: store.getState,
    setAppState: store.setState,
    initialMessages: resumeResult?.messages,
    readFileCache: new FileStateCache(500, 50 * 1024 * 1024),
    customSystemPrompt: options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
    userSpecifiedModel: options.model,
    fallbackModel: options.fallbackModel,
    thinkingConfig: options.thinkingConfig,
    maxTurns: options.maxTurns,
    maxBudgetUsd: options.maxBudgetUsd,
    includePartialMessages: options.includePartialMessages ?? true,
    replayUserMessages: true,
  })
  if (options.model) engine.setModel(options.model)

  return {
    runtimeSessionId,
    submit: (prompt, uuid) =>
      engine.submitMessage(prompt, { uuid: uuid as UUID | undefined }),
    interrupt: () => engine.interrupt(),
    resetAfterInterrupt: () => engine.resetAbortController(),
    setPermissionMode: mode => {
      store.setState(prev => ({
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
          mode: mode as PermissionMode,
        },
      }))
    },
    setModel: model => {
      engine.setModel(model)
    },
    setThinkingConfig: thinkingConfig => {
      engine.setThinkingConfig(thinkingConfig)
    },
    setEffortLevel: level => {
      store.setState(prev => ({
        ...prev,
        effortValue: level,
      }))
    },
    getMessages: () => engine.getMessages(),
    getFileHistoryState: () => store.getState().fileHistory,
    dispose: async () => {
      setChatGPTCredentialsUpdateHandler(undefined)
      for (const client of mcp.clients) {
        if (client.type === 'connected') {
          await client.client.close().catch(() => undefined)
        }
      }
    },
  }
}

import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import type { EffortLevel } from '../../utils/effort.js'
import type { ThinkingConfig } from '../../utils/thinking.js'

export const DESKTOP_PROTOCOL_VERSION = 6
export const DESKTOP_RUNTIME_NAME = 'claude-code-best'

export type DesktopPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

export interface RuntimeEnvelope<T> {
  protocolVersion: number
  requestId: string
  sessionId?: string
  sequence?: number
  timestamp: number
  payload: T
}

export interface RuntimeEnvironment {
  variables: Record<string, string>
  configDir: string
}

export interface RuntimeConfiguredModel {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  effortLevels?: EffortLevel[]
}

export interface RuntimeProviderConfiguration {
  modelType: 'anthropic' | 'openai' | 'gemini' | 'grok'
  defaultModel?: string
  models: RuntimeConfiguredModel[]
}

export interface RuntimeModelInfo {
  value: string
  displayName: string
  description: string
  contextWindow: number
  supportsEffort: boolean
  supportedEffortLevels: EffortLevel[]
  defaultEffortLevel?: EffortLevel
  supportsAdaptiveThinking: boolean
  supportsFastMode: boolean
  supportsAutoMode: boolean
}

export interface RuntimeContextPolicy {
  model: string
  contextWindow: number
  effectiveContextWindow: number
  autoCompactThreshold: number
}

export interface RuntimeContextPolicyCatalog {
  autoCompactEnabled: boolean
  models: RuntimeContextPolicy[]
}

export interface RuntimeModelCatalog {
  defaultModel?: string
  models: RuntimeModelInfo[]
  contextPolicy: RuntimeContextPolicyCatalog
}

export interface RuntimeSessionSummary {
  runtimeSessionId: string
  title: string
  summary: string
  cwd: string
  createdAt?: number
  updatedAt: number
  messageCount?: number
  gitBranch?: string
  tag?: string
}

export interface RuntimeSessionCatalog {
  cwd: string
  sessions: RuntimeSessionSummary[]
  nextOffset?: number
}

export interface RuntimeSessionTranscript {
  runtimeSessionId: string
  cwd: string
  messages: SDKMessage[]
}

export type RuntimeExecutionNodeKind =
  | 'subagent'
  | 'teammate'
  | 'workflow-agent'
  | 'background-task'
  | 'shell'

export type RuntimeExecutionNodeStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'

export interface RuntimeExecutionNode {
  id: string
  parentId?: string
  kind: RuntimeExecutionNodeKind
  name?: string
  status: RuntimeExecutionNodeStatus
  description: string
  startedAt?: number
  completedAt?: number
  toolUseId?: string
  transcriptAvailable: boolean
  summary?: string
  model?: string
  agentType?: string
  teamName?: string
}

export interface RuntimeTodoItem {
  id: string
  content: string
  status: string
  activeForm?: string
  owner?: string
  blocks?: string[]
  blockedBy?: string[]
}

export interface RuntimeExecutionGraph {
  runtimeSessionId?: string
  nodes: RuntimeExecutionNode[]
  todos: RuntimeTodoItem[]
  updatedAt: number
}

export interface RuntimeSubagentTranscript {
  executionNodeId: string
  messages: SDKMessage[]
}

export interface RuntimeSessionOptions {
  cwd: string
  additionalSkillDirectories?: string[]
  runtimeSessionId?: string
  resume?: boolean
  model?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  effortLevel?: EffortLevel
  permissionMode: DesktopPermissionMode
  environment: RuntimeEnvironment
  providerConfiguration?: RuntimeProviderConfiguration
  mcpServers?: Record<string, unknown>
  systemPrompt?: string
  appendSystemPrompt?: string
  maxTurns?: number
  maxBudgetUsd?: number
  includePartialMessages?: boolean
}

export type RuntimeSkillSource =
  | 'ccb-bundled'
  | 'ccb-user'
  | 'ccb-project'
  | 'ccb-plugin'
  | 'ccb-managed'
  | 'proma-project'
  | 'unknown'

export interface RuntimeSkillInfo {
  id: string
  name: string
  description?: string
  source: RuntimeSkillSource
  path?: string
  enabled: boolean
  userInvocable: boolean
  modelInvocable: boolean
  pluginName?: string
  shadowedBy?: string
}

export interface RuntimeSkillCatalog {
  projectPath: string
  skills: RuntimeSkillInfo[]
  resolvedAt: number
}

export type RuntimeCommand =
  | { type: 'host.initialize'; expectedRuntimeVersion?: string }
  | { type: 'host.getCapabilities' }
  | { type: 'host.shutdown' }
  | { type: 'session.open'; options: RuntimeSessionOptions }
  | { type: 'session.resume'; options: RuntimeSessionOptions }
  | { type: 'session.suspend' }
  | { type: 'session.close' }
  | { type: 'session.getState' }
  | {
      type: 'session.resolveModelCatalog'
      cwd: string
      environment: RuntimeEnvironment
      providerConfiguration: RuntimeProviderConfiguration
    }
  | { type: 'session.resolveSkillCatalog'; options: RuntimeSessionOptions }
  | {
      type: 'session.list'
      cwd: string
      environment: RuntimeEnvironment
      limit?: number
      offset?: number
    }
  | {
      type: 'session.getTranscript'
      cwd: string
      environment: RuntimeEnvironment
      runtimeSessionId: string
    }
  | {
      type: 'session.delete'
      cwd: string
      environment: RuntimeEnvironment
      runtimeSessionId: string
    }
  | { type: 'session.getExecutionGraph' }
  | { type: 'session.getSubagentTranscript'; executionNodeId: string }
  | { type: 'session.setPermissionMode'; mode: DesktopPermissionMode }
  | {
      type: 'session.updateConfig'
      model?: string
      thinkingConfig?: ThinkingConfig
      effortLevel?: EffortLevel
    }
  | { type: 'session.setEffortLevel'; level?: EffortLevel }
  | { type: 'session.compact'; instructions?: string }
  | { type: 'session.fork'; upToMessageUuid?: string }
  | { type: 'session.rewind'; messageUuid: string }
  | { type: 'turn.start'; prompt: string; uuid?: string }
  | {
      type: 'turn.enqueue'
      prompt: string
      uuid?: string
      priority?: 'now' | 'next' | 'later'
    }
  | { type: 'turn.interrupt'; prompt?: string; uuid?: string }
  | { type: 'turn.stop' }
  | {
      type: 'interaction.resolve'
      interactionId: string
      response: RuntimeInteractionResponse
    }

export type RuntimeInteractionResponse =
  | {
      outcome: 'allow'
      updatedInput?: Record<string, unknown>
      alwaysAllow?: boolean
    }
  | { outcome: 'deny'; message?: string; alwaysDeny?: boolean }
  | { outcome: 'cancel' }
  | { outcome: 'answer'; answers: Record<string, string | string[]> }
  | { outcome: 'approvePlan'; mode?: DesktopPermissionMode }
  | { outcome: 'rejectPlan'; feedback?: string }

export interface RuntimePermissionRequest {
  interactionId: string
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  suggestions?: unknown[]
}

export interface RuntimeAskUserRequest {
  interactionId: string
  toolUseId: string
  input: Record<string, unknown>
}

export interface RuntimePlanRequest {
  interactionId: string
  toolUseId: string
  input: Record<string, unknown>
}

export interface RuntimeCapabilities {
  runtimeName: typeof DESKTOP_RUNTIME_NAME
  protocolVersion: number
  tools: string[]
  commands: string[]
  skills: string[]
  agents: string[]
  plugins: string[]
  hooks: string[]
  providerTypes: string[]
  mcpCapabilities: string[]
  permissionModes: DesktopPermissionMode[]
  sessionOperations: string[]
  features: string[]
  buildFeatureFlags: string[]
  transportExclusions: string[]
}

export interface RuntimeCapabilitySet {
  tools: string[]
  commands: string[]
  skills: string[]
  agents: string[]
  plugins: string[]
  hooks: string[]
  providerTypes: string[]
  mcpCapabilities: string[]
  permissionModes: DesktopPermissionMode[]
  sessionOperations: string[]
  features: string[]
  buildFeatureFlags: string[]
}

export interface DesktopCapabilityManifest {
  manifestVersion: 1
  generatedFrom: 'shared-core-registries'
  cliCore: RuntimeCapabilitySet
  desktopRuntime: RuntimeCapabilitySet
  transportExclusions: Array<{
    capability: string
    reason: string
  }>
}

export type RuntimeEvent =
  | {
      type: 'host.ready'
      runtimeVersion: string
      capabilities: RuntimeCapabilities
    }
  | { type: 'response.success'; responseTo: string; result?: unknown }
  | { type: 'response.failure'; responseTo: string; error: RuntimeError }
  | {
      type: 'session.stateChanged'
      state:
        | 'cold'
        | 'starting'
        | 'ready'
        | 'busy'
        | 'suspended'
        | 'crashed'
        | 'closed'
      runtimeSessionId?: string
    }
  | { type: 'runtime.message'; message: SDKMessage }
  | { type: 'runtime.executionGraphChanged'; graph: RuntimeExecutionGraph }
  | {
      type: 'runtime.progress'
      phase: string
      detail?: string
      data?: Record<string, unknown>
    }
  | {
      type: 'interaction.permissionRequested'
      request: RuntimePermissionRequest
    }
  | { type: 'interaction.askUserRequested'; request: RuntimeAskUserRequest }
  | { type: 'interaction.planApprovalRequested'; request: RuntimePlanRequest }
  | { type: 'turn.completed'; result?: SDKMessage }
  | { type: 'turn.failed'; error: RuntimeError }
  | {
      type: 'worker.crashed'
      exitCode: number | null
      signal: string | null
      recoverable: boolean
    }
  | {
      type: 'runtime.credentialsUpdated'
      provider: 'openai-codex'
      credentials: {
        access: string
        refresh: string
        expires: number
        accountId?: string
      }
    }
  | {
      type: 'runtime.log'
      level: 'debug' | 'info' | 'warn' | 'error'
      message: string
    }

export interface RuntimeError {
  code: string
  message: string
  stack?: string
  recoverable?: boolean
}

export interface RuntimeManifest {
  runtimeName: typeof DESKTOP_RUNTIME_NAME
  runtimeVersion: string
  gitCommit: string
  protocolVersion: number
  platform: string
  arch: string
  buildTime: string
  entrypoints: {
    host: string
    worker: string
  }
  capabilitiesHash: string
  files: Array<{
    path: string
    sha256: string
    executable?: boolean
  }>
}

export interface WorkerCommandMessage {
  kind: 'command'
  envelope: RuntimeEnvelope<RuntimeCommand>
}

export interface WorkerEventMessage {
  kind: 'event'
  envelope: RuntimeEnvelope<RuntimeEvent>
}

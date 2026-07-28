import { getBuiltInAgents } from '@claude-code-best/builtin-tools/tools/AgentTool/builtInAgents.js'
import { getBuiltInCommandsForCapabilityManifest } from '../../commands.js'
import { HOOK_EVENTS } from '../../entrypoints/agentSdkTypes.js'
import { initBuiltinPlugins } from '../../plugins/bundled/index.js'
import { getBuiltinPluginDefinitions } from '../../plugins/builtinPlugins.js'
import { initBundledSkills } from '../../skills/bundled/index.js'
import { getBundledSkills } from '../../skills/bundledSkills.js'
import { getAllBaseTools } from '../../tools.js'
import type { RuntimeCapabilitySet } from '../protocol/types.js'

const PROVIDER_TYPES = [
  'firstParty',
  'bedrock',
  'vertex',
  'foundry',
  'openai',
  'gemini',
  'grok',
] as const

const MCP_CAPABILITIES = [
  'stdio-servers',
  'sse-servers',
  'http-servers',
  'resources',
  'resource-templates',
  'oauth',
  'dynamic-tools',
] as const

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const

const SESSION_OPERATIONS = [
  'open',
  'resume',
  'suspend',
  'close',
  'delete',
  'compact',
  'fork',
  'rewind',
] as const

const CORE_FEATURES = [
  'mcp',
  'hooks',
  'plugins',
  'skills',
  'commands',
  'subagents',
  'background-tasks',
  'cron',
  'workflow',
  'teams',
  'worktrees',
  'lsp',
  'notebook',
  'web',
  'computer-use',
] as const

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

/**
 * 从 CLI 与 Desktop 共用的注册表生成 Core Capability Set。
 *
 * 这里只读取构建内置定义，不扫描用户目录和项目目录，因此 Artifact 在相同
 * commit、平台、架构和 Feature Flags 下保持确定性。
 */
export function createCoreCapabilitySet(
  buildFeatureFlags: readonly string[],
): RuntimeCapabilitySet {
  initBundledSkills()
  initBuiltinPlugins()

  return {
    tools: sortedUnique(getAllBaseTools().map(tool => tool.name)),
    commands: sortedUnique(
      getBuiltInCommandsForCapabilityManifest().flatMap(command => [
        command.name,
        ...(command.aliases ?? []),
      ]),
    ),
    skills: sortedUnique(
      getBundledSkills().flatMap(skill => [
        skill.name,
        ...(skill.aliases ?? []),
      ]),
    ),
    agents: sortedUnique(getBuiltInAgents().map(agent => agent.agentType)),
    plugins: sortedUnique(
      getBuiltinPluginDefinitions().map(plugin => plugin.name),
    ),
    hooks: sortedUnique(HOOK_EVENTS),
    providerTypes: [...PROVIDER_TYPES],
    mcpCapabilities: [...MCP_CAPABILITIES],
    permissionModes: [...PERMISSION_MODES],
    sessionOperations: [...SESSION_OPERATIONS],
    features: [...CORE_FEATURES],
    buildFeatureFlags: sortedUnique(buildFeatureFlags),
  }
}

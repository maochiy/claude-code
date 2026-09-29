import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { getAPIProvider } from '../utils/model/providers.js'
import {
  activateProviderProfile,
  getConfiguredProviderProfiles,
  isProviderProfileType,
} from '../utils/model/providerProfiles.js'
import {
  updateSettingsForSource,
  getSettings_DEPRECATED,
} from '../utils/settings/settings.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'

function getEnvVarForProvider(provider: string): string {
  switch (provider) {
    case 'bedrock':
      return 'CLAUDE_CODE_USE_BEDROCK'
    case 'vertex':
      return 'CLAUDE_CODE_USE_VERTEX'
    case 'foundry':
      return 'CLAUDE_CODE_USE_FOUNDRY'
    case 'gemini':
      return 'CLAUDE_CODE_USE_GEMINI'
    case 'grok':
      return 'CLAUDE_CODE_USE_GROK'
    default:
      throw new Error(`Unknown provider: ${provider}`)
  }
}

// Get merged env: process.env + settings.env (from userSettings)
function getMergedEnv(): Record<string, string> {
  const settings = getSettings_DEPRECATED()
  const merged: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  )
  if (settings?.env) {
    Object.assign(merged, settings.env)
  }
  return merged
}

const call: LocalCommandCall = async (args, _context) => {
  const arg = args.trim().toLowerCase()

  // No argument: show current provider and any saved profiles
  if (!arg) {
    const current = getAPIProvider()
    const profiles = getConfiguredProviderProfiles()
    const lines = [`Current API provider: ${current}`]
    if (profiles.length > 0) {
      lines.push('Saved provider profiles:')
      for (const { name, type } of profiles) {
        lines.push(`  · ${name}${name === type ? '' : ` (${type})`}`)
      }
      lines.push('Switch with /provider <name>')
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // unset - clear settings, fallback to env vars
  if (arg === 'unset') {
    updateSettingsForSource('userSettings', { modelType: undefined })
    // Also clear all provider-specific env vars to prevent conflicts
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GROK
    return {
      type: 'text',
      value: 'API provider cleared (will use environment variables).',
    }
  }

  // Validate provider
  const validProviders = [
    'anthropic',
    'openai',
    'gemini',
    'grok',
    'bedrock',
    'vertex',
    'foundry',
  ]
  if (!validProviders.includes(arg)) {
    return {
      type: 'text',
      value: `Invalid provider: ${arg}\nValid: ${validProviders.join(', ')}`,
    }
  }

  // Profile-backed providers: accept either a profile NAME (e.g. "xiuda")
  // or a legacy type name ("openai" → activates the profile saved under that
  // name when one exists). Snapshot the outgoing provider into its own
  // profile and restore the target provider's saved config, so multiple
  // providers can coexist.
  const namedProfile = getConfiguredProviderProfiles().find(p => p.name === arg)
  if (namedProfile || isProviderProfileType(arg)) {
    const targetName = namedProfile?.name ?? arg
    const { error } = activateProviderProfile(targetName)
    if (error) {
      return {
        type: 'text',
        value: `Failed to switch provider: ${error.message}`,
      }
    }
    // Ensure settings.env gets applied to process.env
    applyConfigEnvironmentVariables()
    if (namedProfile?.type === 'openai' || arg === 'openai') {
      const { clearOpenAIClientCache } = await import(
        'src/services/api/openai/client.js'
      )
      clearOpenAIClientCache()
    }
    return {
      type: 'text',
      value: `API provider set to ${targetName}. Takes effect on the next turn.`,
    }
  }

  // Check env vars when switching to grok via legacy shell env (no profile saved)
  if (arg === 'grok') {
    const mergedEnv = getMergedEnv()
    const hasKey = !!(mergedEnv.GROK_API_KEY || mergedEnv.XAI_API_KEY)
    if (!hasKey) {
      return {
        type: 'text',
        value: `No saved profile for grok.\nWarning: Missing env var: GROK_API_KEY (or XAI_API_KEY)\nConfigure it via /login or settings.json env.`,
      }
    }
    updateSettingsForSource('userSettings', { modelType: 'grok' })
    return {
      type: 'text',
      value: `API provider set to grok (via environment variable).`,
    }
  }

  // Cloud providers: set env vars only, do NOT touch settings.json
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GROK
  process.env[getEnvVarForProvider(arg)] = '1'
  // Do not modify settings.json - cloud providers controlled solely by env vars
  applyConfigEnvironmentVariables()
  return {
    type: 'text',
    value: `API provider set to ${arg} (via environment variable).`,
  }
}

const provider = {
  type: 'local',
  name: 'provider',
  description:
    'Switch API provider (anthropic/openai/gemini/grok/bedrock/vertex/foundry)',
  aliases: ['api'],
  argumentHint: '[anthropic|openai|gemini|grok|bedrock|vertex|foundry|unset]',
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default provider

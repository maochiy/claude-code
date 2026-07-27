import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enableConfigs } from '../../utils/config.js'
import { createCoreCapabilitySet } from './createCoreCapabilitySet.js'

const ENVIRONMENT_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS',
  'CLAUDE_CODE_COORDINATOR_MODE',
  'CLAUDE_CODE_ENABLE_CFC',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CONFIG_DIR',
  'IS_DEMO',
  'USER_TYPE',
] as const

/**
 * Capability Probe 运行在和目标 Artifact 相同 Feature Flags 的临时 Bundle 中。
 * 生成前清理宿主 Provider/Auth 环境，防止开发机配置影响 Manifest。
 */
export function createBuildCapabilitySet(
  buildFeatureFlags: readonly string[],
): ReturnType<typeof createCoreCapabilitySet> {
  const original = new Map<string, string | undefined>()
  const isolatedConfigDir = mkdtempSync(
    join(tmpdir(), 'ccb-capability-config-'),
  )
  for (const key of ENVIRONMENT_KEYS) {
    original.set(key, process.env[key])
    delete process.env[key]
  }
  const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
  process.env.CLAUDE_CONFIG_DIR = isolatedConfigDir
  process.env.CLAUDE_CODE_ENTRYPOINT = 'desktop'
  process.env.CLAUDE_CODE_ENABLE_CFC = '0'

  try {
    enableConfigs()
    return createCoreCapabilitySet(buildFeatureFlags)
  } finally {
    for (const key of ENVIRONMENT_KEYS) {
      const value = original.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (originalEntrypoint === undefined) {
      delete process.env.CLAUDE_CODE_ENTRYPOINT
    } else {
      process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
    }
    rmSync(isolatedConfigDir, { recursive: true, force: true })
  }
}

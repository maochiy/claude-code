import { describe, expect, test } from 'bun:test'
import type {
  DesktopCapabilityManifest,
  RuntimeCapabilitySet,
} from '../protocol/types.js'
import {
  assertCapabilityParity,
  assertDesktopCapabilityManifest,
} from './manifest.js'

function createCapabilitySet(
  overrides: Partial<RuntimeCapabilitySet> = {},
): RuntimeCapabilitySet {
  return {
    tools: ['Read'],
    commands: ['help'],
    skills: ['simplify'],
    agents: ['general-purpose'],
    plugins: ['weixin'],
    hooks: ['PreToolUse'],
    providerTypes: ['firstParty'],
    mcpCapabilities: ['stdio-servers'],
    permissionModes: ['default'],
    sessionOperations: ['open'],
    features: ['mcp'],
    buildFeatureFlags: ['WORKFLOW_SCRIPTS'],
    ...overrides,
  }
}

function createManifest(): DesktopCapabilityManifest {
  return {
    manifestVersion: 1,
    generatedFrom: 'shared-core-registries',
    cliCore: createCapabilitySet({
      buildFeatureFlags: ['ACP', 'WORKFLOW_SCRIPTS'],
    }),
    desktopRuntime: createCapabilitySet(),
    transportExclusions: [
      {
        capability: 'ACP',
        reason: 'Desktop 使用原生双 MessagePort Runtime Protocol',
      },
    ],
  }
}

describe('Desktop Capability Manifest', () => {
  test('允许明确声明的 Transport Feature 排除', () => {
    expect(() => assertCapabilityParity(createManifest())).not.toThrow()
  })

  test('Desktop 缺少共享 Core 能力时 parity 校验失败', () => {
    const manifest = createManifest()
    manifest.desktopRuntime.tools = []
    expect(() => assertCapabilityParity(manifest)).toThrow(
      'CLI/Desktop Capability 不一致: tools',
    )
  })

  test('拒绝未声明的 Build Feature 差异', () => {
    const manifest = createManifest()
    manifest.cliCore.buildFeatureFlags.push('UNDECLARED')
    expect(() => assertCapabilityParity(manifest)).toThrow(
      'Desktop 缺少未声明排除的 Build Feature',
    )
  })

  test('Schema 校验拒绝缺失数组字段', () => {
    const manifest = createManifest()
    const invalid = {
      ...manifest,
      desktopRuntime: {
        ...manifest.desktopRuntime,
        commands: undefined,
      },
    }
    expect(() => assertDesktopCapabilityManifest(invalid)).toThrow(
      'Capability Manifest 字段无效: commands',
    )
  })
})

import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_RUNTIME_NAME,
  type DesktopCapabilityManifest,
  type RuntimeCapabilities,
  type RuntimeCapabilitySet,
} from '../protocol/types.js'

function assertStringArray(
  value: unknown,
  field: keyof RuntimeCapabilitySet,
): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`Capability Manifest 字段无效: ${field}`)
  }
}

export function assertCapabilitySet(value: unknown): RuntimeCapabilitySet {
  if (!value || typeof value !== 'object') {
    throw new Error('Capability Set 必须是对象')
  }
  const capabilitySet = value as Partial<RuntimeCapabilitySet>
  const fields: Array<keyof RuntimeCapabilitySet> = [
    'tools',
    'commands',
    'skills',
    'agents',
    'plugins',
    'hooks',
    'providerTypes',
    'mcpCapabilities',
    'permissionModes',
    'sessionOperations',
    'features',
    'buildFeatureFlags',
  ]
  for (const field of fields) {
    assertStringArray(capabilitySet[field], field)
  }
  return capabilitySet as RuntimeCapabilitySet
}

export function assertDesktopCapabilityManifest(
  value: unknown,
): DesktopCapabilityManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('Capability Manifest 必须是对象')
  }
  const manifest = value as Partial<DesktopCapabilityManifest>
  if (
    manifest.manifestVersion !== 1 ||
    manifest.generatedFrom !== 'shared-core-registries'
  ) {
    throw new Error('Capability Manifest 版本或来源无效')
  }
  const cliCore = assertCapabilitySet(manifest.cliCore)
  const desktopRuntime = assertCapabilitySet(manifest.desktopRuntime)
  if (
    !Array.isArray(manifest.transportExclusions) ||
    manifest.transportExclusions.some(
      exclusion =>
        !exclusion ||
        typeof exclusion.capability !== 'string' ||
        typeof exclusion.reason !== 'string',
    )
  ) {
    throw new Error('Capability Manifest 缺少 transportExclusions')
  }
  return {
    manifestVersion: 1,
    generatedFrom: 'shared-core-registries',
    cliCore,
    desktopRuntime,
    transportExclusions: manifest.transportExclusions,
  }
}

export function loadDesktopRuntimeCapabilities(): RuntimeCapabilities {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const artifactRoot =
    basename(moduleDir) === 'chunks' ? dirname(moduleDir) : moduleDir
  const manifestPath = join(artifactRoot, 'capability-manifest.json')
  const manifest = assertDesktopCapabilityManifest(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
  )
  return {
    runtimeName: DESKTOP_RUNTIME_NAME,
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    ...manifest.desktopRuntime,
    transportExclusions: manifest.transportExclusions.map(
      exclusion => exclusion.capability,
    ),
  }
}

export function assertCapabilityParity(
  manifest: DesktopCapabilityManifest,
): void {
  const fields: Array<keyof RuntimeCapabilitySet> = [
    'tools',
    'commands',
    'skills',
    'agents',
    'plugins',
    'hooks',
    'providerTypes',
    'mcpCapabilities',
    'permissionModes',
    'sessionOperations',
    'features',
  ]
  for (const field of fields) {
    const cliValues = manifest.cliCore[field]
    const desktopValues = manifest.desktopRuntime[field]
    if (JSON.stringify(cliValues) !== JSON.stringify(desktopValues)) {
      throw new Error(
        `CLI/Desktop Capability 不一致: ${field}\nCLI=${JSON.stringify(cliValues)}\nDesktop=${JSON.stringify(desktopValues)}`,
      )
    }
  }

  const excludedFlags = new Set(
    manifest.transportExclusions.map(exclusion => exclusion.capability),
  )
  const cliOnlyFlags = manifest.cliCore.buildFeatureFlags.filter(
    flag => !manifest.desktopRuntime.buildFeatureFlags.includes(flag),
  )
  const unexpected = cliOnlyFlags.filter(flag => !excludedFlags.has(flag))
  if (unexpected.length > 0) {
    throw new Error(
      `Desktop 缺少未声明排除的 Build Feature: ${unexpected.join(', ')}`,
    )
  }
}

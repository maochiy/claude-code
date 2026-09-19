/** 自有 CLI 注册表。执行产物随桌面版本交付，历史 Runtime 仅供读取。 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeCapability, RuntimeCapabilitySnapshot, RuntimeConfig, RuntimeDefinition,
  RuntimeDiscoveryCandidate, RuntimeId, RuntimePackage, RuntimePackageStatus } from '@proma/shared'
import { getRuntimeConfigPath, getRuntimeHomeDir } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import { EXECUTABLE_RUNTIME_ID, isExecutableRuntimeId } from './executable-runtime-policy'
import { resolveLocalRuntimePaths } from '../local-service/paths'

export const ALL_RUNTIME_IDS: readonly RuntimeId[] = [EXECUTABLE_RUNTIME_ID]
const capabilities: RuntimeCapability[] = ['streaming', 'tools', 'approvals', 'steering', 'cancellation',
  'sessionResume', 'customModels', 'managedCredentials', 'contextUsage', 'compaction', 'workTasks']

export function resolveDefaultRuntimeHome(env: Readonly<Record<string, string | undefined>>, fallback = getRuntimeHomeDir): string {
  return env.XCODES_RUNTIME_HOME || env.PROMA_RUNTIME_HOME || fallback()
}
export function migrateRuntimeConfig(stored?: Partial<RuntimeConfig> | null, now = Date.now()): RuntimeConfig {
  return { runtimeHome: stored?.runtimeHome || resolveDefaultRuntimeHome(process.env),
    runtimeSourceHome: process.env.XCODES_CLI_SOURCE_ROOT || stored?.runtimeSourceHome || null,
    runtimeApiBaseUrl: null, defaultRuntimeId: EXECUTABLE_RUNTIME_ID, defaultHarnessId: EXECUTABLE_RUNTIME_ID,
    enabledRuntimeIds: [EXECUTABLE_RUNTIME_ID], routedHarnesses: [], updatedAt: stored?.updatedAt || now }
}
export function getRuntimeConfig(): RuntimeConfig { return migrateRuntimeConfig(readJsonFileSafe<RuntimeConfig>(getRuntimeConfigPath())) }
export function updateRuntimeConfig(updates: Partial<RuntimeConfig>): RuntimeConfig {
  const next = migrateRuntimeConfig({ ...getRuntimeConfig(), ...updates, updatedAt: Date.now() })
  writeJsonFileAtomic(getRuntimeConfigPath(), next)
  return next
}
function host(): { packaged: boolean; appPath: string; resourcesPath?: string } {
  try {
    const electron = require('electron') as { app?: { isPackaged: boolean; getAppPath(): string } }
    return { packaged: electron.app?.isPackaged === true, appPath: electron.app?.getAppPath() || process.cwd(), resourcesPath: process.resourcesPath }
  } catch { return { packaged: false, appPath: process.cwd() } }
}
export function isPackagedElectronApp(): boolean { return host().packaged }
export function listRuntimes(): RuntimeDefinition[] {
  let path: string | null = null
  let version: string | null = null
  let detail = '未找到本地 CLI 构建产物'
  try {
    const paths = resolveLocalRuntimePaths({ ...host(), sourceRoot: getRuntimeConfig().runtimeSourceHome || undefined })
    path = paths.cliEntry
    const manifest = join(paths.root, 'package.json')
    if (existsSync(manifest)) version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version || null
    detail = existsSync(path) ? '本地 CLI 已安装；具体能力由会话握手确认' : '请先构建本地 CLI'
  } catch (error) { detail = error instanceof Error ? error.message : detail }
  return [{ id: EXECUTABLE_RUNTIME_ID, role: 'kernel', name: 'Local CLI', description: '自有 CLI 本地执行内核',
    command: path, bundled: true, capabilities: [...capabilities], installation: {
      runtimeId: EXECUTABLE_RUNTIME_ID, status: path && existsSync(path) ? 'ready' : 'missing',
      version, executablePath: path, source: 'bundled', detail, checkedAt: Date.now(),
    } }]
}
export async function refreshRuntimes(): Promise<RuntimeDefinition[]> { return listRuntimes() }
function assertLocal(runtimeId: RuntimeId): void {
  if (!isExecutableRuntimeId(runtimeId)) throw new Error('旧 Runtime 只用于读取历史，不能再启动执行')
}
export function getRuntimeCapabilities(runtimeId: RuntimeId): RuntimeCapabilitySnapshot {
  assertLocal(runtimeId)
  return { runtimeId, runtimeVersion: listRuntimes()[0]!.installation.version || '', source: 'bundled',
    capabilities: Object.fromEntries(capabilities.map((key) => [key, 'unknown'])), checkedAt: Date.now() }
}
export function detectRuntime(runtimeId: RuntimeId): RuntimeDefinition | null { return isExecutableRuntimeId(runtimeId) ? listRuntimes()[0]! : null }
export async function discoverRuntime(runtimeId: RuntimeId): Promise<RuntimeDiscoveryCandidate[]> {
  assertLocal(runtimeId)
  const { installation } = listRuntimes()[0]!
  return installation.executablePath ? [{ executablePath: installation.executablePath, version: installation.version, source: 'managed', detail: installation.detail }] : []
}
export function scanManagedRuntimePackages(_home: string, _runtimeId: RuntimeId, _platform?: string): RuntimePackage[] { return [] }
export async function getRuntimePackageStatus(runtimeId: RuntimeId): Promise<RuntimePackageStatus> {
  assertLocal(runtimeId)
  const { installation } = listRuntimes()[0]!
  const active: RuntimePackage | null = installation.status === 'ready' ? {
    runtimeId, runtimeVersion: installation.version || 'bundled', runtimeBuildId: `local-cli-${installation.version || 'bundled'}`,
    source: 'bundled', installationState: 'installed', availability: 'ready', executablePath: installation.executablePath,
    runtimeDir: installation.executablePath, installedAt: null, verifiedAt: null, detail: installation.detail,
  } : null
  return { runtimeId, activation: active ? { runtimeId, activeBuildId: active.runtimeBuildId, previousBuildId: null, activationRevision: active.runtimeBuildId } : null,
    activeBinding: active, packages: active ? [active] : [], upstreamLatest: null, checkedAt: new Date().toISOString(), source: 'local' }
}
export async function getActiveRuntimePackage(runtimeId: RuntimeId): Promise<RuntimePackage | null> { return (await getRuntimePackageStatus(runtimeId)).activeBinding }
export async function installRuntimePackage(_runtimeId: RuntimeId, _version: string): Promise<RuntimePackageStatus> { throw new Error('执行内核随应用更新，请使用桌面更新入口') }
export async function activateRuntimePackage(runtimeId: RuntimeId, buildId: string): Promise<RuntimePackageStatus> {
  const status = await getRuntimePackageStatus(runtimeId)
  if (status.activeBinding?.runtimeBuildId !== buildId) throw new Error('此构建不属于当前桌面版本')
  return status
}
export async function deleteRuntimePackage(_runtimeId: RuntimeId, _version: string): Promise<RuntimePackageStatus> { throw new Error('不能删除随应用提供的执行内核') }
export async function bindNativeRuntime(_runtimeId: RuntimeId, _executablePath: string): Promise<RuntimePackageStatus> { throw new Error('桌面使用随版本交付的 CLI，不绑定任意系统命令') }
export async function unbindNativeRuntime(_runtimeId: RuntimeId, _buildId: string): Promise<RuntimePackageStatus> { throw new Error('桌面使用随版本交付的 CLI，无需解绑') }

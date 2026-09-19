import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALL_RUNTIME_IDS,
  detectRuntime,
  listRuntimes,
  migrateRuntimeConfig,
  resolveDefaultRuntimeHome,
  scanManagedRuntimePackages,
} from './runtime-registry'
import { getRuntimeHomeDir } from '../config-paths'

describe('Proma Runtime Registry 契约', () => {
  test('Given 历史 Runtime 类型仍可读取 When 枚举可执行运行时 Then 只注册 Local CLI', () => {
    expect(ALL_RUNTIME_IDS).toEqual(['local-cli'])
    expect(detectRuntime('hermes')).toBeNull()
    expect(detectRuntime('codex')).toBeNull()
    expect(detectRuntime('claude')).toBeNull()
  })

  test('Given Proma Runtime Home 中混有旧内核托管包 When 扫描当前平台 Then 不再发现可执行旧包', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-runtime-'))
    try {
      expect(scanManagedRuntimePackages(root, 'pi', 'darwin-arm64')).toEqual([])
      expect(scanManagedRuntimePackages(root, 'codex', 'darwin-arm64')).toEqual([])
      expect(scanManagedRuntimePackages(root, 'claude', 'darwin-arm64')).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given 旧多内核运行时配置 When 迁移 Then 执行字段全部收敛到 Local CLI', () => {
    const migrated = migrateRuntimeConfig({
      runtimeHome: '/tmp/runtime',
      runtimeSourceHome: null,
      runtimeApiBaseUrl: null,
      defaultRuntimeId: 'claude',
      defaultHarnessId: 'codex',
      enabledRuntimeIds: ['hermes', 'codex', 'claude'],
      routedHarnesses: ['codex', 'claude'],
      updatedAt: 123,
    }, 456)
    expect(migrated.defaultRuntimeId).toBe('local-cli')
    expect(migrated.defaultHarnessId).toBe('local-cli')
    expect(migrated.enabledRuntimeIds).toEqual(['local-cli'])
    expect(migrated.routedHarnesses).toEqual([])
    expect(migrated.runtimeHome).toBe('/tmp/runtime')
  })

  test('Given 新用户未显式配置 Runtime Home When 生成默认路径 Then 使用配置目录 runtime 子目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'xcodes-runtime-home-'))
    try {
      const configDir = join(root, 'xcodes')
      expect(resolveDefaultRuntimeHome({}, () => getRuntimeHomeDir(configDir)))
        .toBe(join(configDir, 'runtime'))
      expect(resolveDefaultRuntimeHome(
        { PROMA_RUNTIME_HOME: join(root, '.proma-runtime-explicit') },
        () => getRuntimeHomeDir(configDir),
      )).toBe(join(root, '.proma-runtime-explicit'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('内置 Runtime 安装包绑定', () => {
  test('Given Local CLI 尚未构建 When 枚举 Runtime Then 仍只返回 bundled 来源且不回退系统 PATH', () => {
    const runtimes = listRuntimes()
    expect(runtimes.map((runtime) => runtime.id)).toEqual(['local-cli'])
    const runtime = runtimes[0]
    expect(runtime).toBeDefined()
    if (!runtime) return
    expect(runtime.installation.source).toBe('bundled')
    expect(['ready', 'missing']).toContain(runtime.installation.status)
    expect(runtime.installation.source).not.toBe('system')
  })
})

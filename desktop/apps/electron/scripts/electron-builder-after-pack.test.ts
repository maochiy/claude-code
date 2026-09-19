import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import afterPack from './electron-builder-after-pack'
import { resolvePackagedResourcesRoot } from './local-runtime-artifacts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('afterPack 本地 Runtime 完整性守卫', () => {
  test('Given darwin 产物缺少本地 Runtime When afterPack Then 抛错中断打包', () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'proma-after-pack-cli-'))
    temporaryDirectories.push(appOutDir)

    expect(() =>
      afterPack({
        appOutDir,
        electronPlatformName: 'darwin',
        arch: 3,
        packager: {
          appInfo: {
            productFilename: 'Xcodes',
          },
        },
      }),
    ).toThrow(/本地 Runtime 缺少/)
  })

  test('Given darwin 目标 When 解析资源路径 Then 使用应用 Bundle', () => {
    expect(resolvePackagedResourcesRoot('/out', 'darwin')).toContain('Xcodes.app')
  })

  test('Given context 提供实际 Bundle 名 When afterPack Then 动态使用该名称', () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'proma-after-pack-context-'))
    temporaryDirectories.push(appOutDir)

    expect(() =>
      afterPack({
        appOutDir,
        electronPlatformName: 'darwin',
        arch: 3,
        packager: {
          appInfo: {
            productFilename: 'context-name',
          },
        },
      }),
    ).toThrow(/context-name\.app/)
  })
})

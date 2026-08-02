import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import {
  copySharpNativeDependencies,
  getSharpRuntimePackageNames,
} from '../sharp-native-packaging.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(path => rm(path, { recursive: true, force: true })),
  )
})

describe('Sharp 桌面 Runtime 原生依赖打包', () => {
  test('Given macOS arm64, when resolving package names, then both Sharp binary and libvips packages are selected', () => {
    expect(getSharpRuntimePackageNames('darwin', 'arm64')).toEqual([
      '@img/sharp-darwin-arm64',
      '@img/sharp-libvips-darwin-arm64',
    ])
  })

  test('Given Windows x64, when resolving package names, then only the self-contained Sharp package is selected', () => {
    expect(getSharpRuntimePackageNames('win32', 'x64')).toEqual([
      '@img/sharp-win32-x64',
    ])
  })

  test('Given a desktop artifact directory, when copying Sharp dependencies, then bundled chunks can resolve the native packages', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'ccb-sharp-artifact-'))
    temporaryDirectories.push(artifactDir)

    const packageNames = await copySharpNativeDependencies(artifactDir)
    expect(packageNames).toEqual(
      getSharpRuntimePackageNames(process.platform, process.arch),
    )

    for (const packageName of packageNames) {
      const packagePath = join(
        artifactDir,
        'node_modules',
        ...packageName.split('/'),
        'package.json',
      )
      expect((await stat(packagePath)).isFile()).toBe(true)
    }

    const runtimeRequire = createRequire(
      join(artifactDir, 'chunks', 'sharp-runtime-probe.cjs'),
    )
    const sharpPackage = packageNames[0]
    if (!sharpPackage) {
      throw new Error('Sharp 平台包未生成')
    }
    expect(runtimeRequire.resolve(`${sharpPackage}/sharp.node`)).toContain(
      artifactDir,
    )
    for (const libvipsPackage of packageNames.slice(1)) {
      expect(runtimeRequire.resolve(`${libvipsPackage}/lib`)).toContain(
        artifactDir,
      )
    }
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getSessionCliWrapperSource,
  isSessionCliHelpSuccessful,
  promoteVerifiedLocalRuntime,
  resolvePackagedResourcesRoot,
  verifyLocalRuntimeResources,
  verifyPackagedLocalRuntime,
  type ElectronBuilderPlatform,
  type RuntimeArchitecture,
} from './local-runtime-artifacts'

const temporaryDirectories: string[] = []

function makeNativeFixture(
  platform: ElectronBuilderPlatform,
  arch: RuntimeArchitecture,
  version?: string,
): Buffer {
  const binary = Buffer.alloc(256)
  if (platform === 'darwin') {
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(binary)
    binary.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  } else if (platform === 'linux') {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(binary)
    binary.writeUInt16LE(arch === 'arm64' ? 0x00b7 : 0x003e, 18)
  } else {
    Buffer.from('MZ').copy(binary)
    binary.writeUInt32LE(0x80, 0x3c)
    Buffer.from('PE\0\0').copy(binary, 0x80)
    binary.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 0x84)
  }
  return version ? Buffer.concat([binary, Buffer.from(`fixture-bun-${version}`)]) : binary
}

function keyringName(platform: ElectronBuilderPlatform, arch: RuntimeArchitecture): string {
  if (platform === 'win32') return `keyring.win32-${arch}-msvc.node`
  if (platform === 'linux') return `keyring.linux-${arch}-gnu.node`
  return `keyring.darwin-${arch}.node`
}

function makeResources(platform: ElectronBuilderPlatform, arch: RuntimeArchitecture): string {
  const root = mkdtempSync(join(tmpdir(), 'xcodes-local-runtime-'))
  temporaryDirectories.push(root)
  const keyring = keyringName(platform, arch)
  const files: Record<string, string | Buffer> = {
    'local-runtime/package.json': '{"version":"1.0.0","bun":"1.3.14"}',
    'local-runtime/cli/cli.js': 'import "./chunks/entry.js"\nconst binding = await import("@napi-rs/keyring")\n',
    'local-runtime/cli/chunks/entry.js': 'export {}\n',
    'local-runtime/cli/node_modules/@napi-rs/keyring/package.json': '{"name":"@napi-rs/keyring","version":"2.1.0","main":"index.js"}',
    'local-runtime/cli/node_modules/@napi-rs/keyring/index.js': `module.exports = require("./${keyring}")\n`,
    [`local-runtime/cli/node_modules/@napi-rs/keyring/${keyring}`]: makeNativeFixture(platform, arch),
    'local-runtime/cli/vendor/audio-capture/addon.node': 'native',
    'local-runtime/cli/vendor/ripgrep/rg': 'binary',
    'local-runtime/session-cli/index.js': 'console.log("help")\n',
    [`local-runtime/session-cli/${platform === 'win32' ? 'proma.cmd' : 'proma'}`]: getSessionCliWrapperSource(platform),
    'local-runtime/service/index.js': 'export {}\n',
    [`vendor/bun/${platform === 'win32' ? 'bun.exe' : 'bun'}`]: makeNativeFixture(platform, arch, '1.3.14'),
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    if (relativePath.endsWith('/proma')) chmodSync(path, 0o755)
  }
  return root
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('本地 Runtime 打包完整性', () => {
  test('Given CLI chunks、资源、Service 与 Bun 完整 When 校验 Then 返回入口信息', () => {
    const resources = makeResources('darwin', 'arm64')
    const result = verifyLocalRuntimeResources(resources, 'darwin', undefined, 'arm64')
    expect(result.cliJavaScriptFiles).toBe(2)
    expect(result.cliEntry).toBe(join(resources, 'local-runtime/cli/cli.js'))
    expect(result.serviceEntry).toBe(join(resources, 'local-runtime/service/index.js'))
    expect(result.sessionCliWrapper).toBe(join(resources, 'local-runtime/session-cli/proma'))
  })

  test('Given CLI 引用缺失 chunk When 校验 Then 阻止发布', () => {
    const resources = makeResources('linux', 'x64')
    writeFileSync(
      join(resources, 'local-runtime/cli/cli.js'),
      'import "./chunks/missing.js"\nconst binding = await import("@napi-rs/keyring")\n',
    )
    expect(() => verifyLocalRuntimeResources(resources, 'linux', undefined, 'x64')).toThrow(/断裂引用/)
  })

  test('Given CLI chunks 直接位于 dist 根目录 When 校验 Then 仍识别完整模块图', () => {
    const resources = makeResources('linux', 'x64')
    const nested = join(resources, 'local-runtime/cli/chunks/entry.js')
    const flat = join(resources, 'local-runtime/cli/chunk-entry.js')
    renameSync(nested, flat)
    writeFileSync(
      join(resources, 'local-runtime/cli/cli.js'),
      'import "./chunk-entry.js"\nconst binding = await import("@napi-rs/keyring")\n',
    )
    expect(verifyLocalRuntimeResources(resources, 'linux', undefined, 'x64').cliJavaScriptFiles).toBe(2)
  })

  test('Given Windows 产物缺少 cmd wrapper When 校验 Then 阻止发布', () => {
    const resources = makeResources('win32', 'x64')
    rmSync(join(resources, 'local-runtime/session-cli/proma.cmd'))
    expect(() => verifyLocalRuntimeResources(resources, 'win32', undefined, 'x64')).toThrow(/会话辅助 CLI wrapper/)
  })

  test('Given wrapper 被改为任意命令 When 校验 Then 阻止发布', () => {
    const resources = makeResources('darwin', 'arm64')
    writeFileSync(join(resources, 'local-runtime/session-cli/proma'), '#!/bin/sh\necho unsafe\n')
    expect(() => verifyLocalRuntimeResources(resources, 'darwin', undefined, 'arm64')).toThrow(/固定启动协议/)
  })

  test('Given 各平台 wrapper When 生成 Then 仅用内置 Bun 启动固定辅助入口', () => {
    expect(getSessionCliWrapperSource('darwin')).toContain('exec "$SCRIPT_DIR/../../vendor/bun/bun" "$SCRIPT_DIR/index.js" "$@"')
    expect(getSessionCliWrapperSource('win32')).toContain('"%~dp0..\\..\\vendor\\bun\\bun.exe" "%~dp0index.js" %*')
  })

  test('Given CLI 人读帮助写入 stderr When 冒烟检查 Then 识别为成功', () => {
    expect(isSessionCliHelpSuccessful(0, '', 'proma — Proma 会话渐进式读取 CLI')).toBe(true)
    expect(isSessionCliHelpSuccessful(1, '', 'proma — Proma 会话渐进式读取 CLI')).toBe(false)
  })

  test.each([
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'x64'],
    ['win32', 'x64'],
  ] as const)(
    'Given %s-%s 固定 Bun 与 keyring When 静态校验 Then 接受对应格式与架构',
    (platform, arch) => {
      const resources = makeResources(platform, arch)
      expect(verifyLocalRuntimeResources(resources, platform, undefined, arch).target).toBe(`${platform}-${arch}`)
    },
  )

  test('Given Bun 二进制版本与清单不一致 When 校验 Then 阻止发布', () => {
    const resources = makeResources('win32', 'x64')
    writeFileSync(join(resources, 'vendor/bun/bun.exe'), makeNativeFixture('win32', 'x64', '1.3.13'))
    expect(() => verifyLocalRuntimeResources(resources, 'win32', undefined, 'x64')).toThrow(/固定版本 1\.3\.14/)
  })

  test('Given x64 安装包误带 arm64 keyring When 校验 Then 阻止发布', () => {
    const resources = makeResources('darwin', 'x64')
    const addon = join(resources, 'local-runtime/cli/node_modules/@napi-rs/keyring/keyring.darwin-x64.node')
    writeFileSync(addon, makeNativeFixture('darwin', 'arm64'))
    expect(() => verifyLocalRuntimeResources(resources, 'darwin', undefined, 'x64')).toThrow(/keyring addon 架构/)
  })

  test('Given CLI 保留 external 引用但 loader 包缺失 When 校验 Then 阻止发布', () => {
    const resources = makeResources('darwin', 'arm64')
    rmSync(join(resources, 'local-runtime/cli/node_modules/@napi-rs/keyring'), { recursive: true })
    expect(() => verifyLocalRuntimeResources(resources, 'darwin', undefined, 'arm64'))
      .toThrow(/keyring loader 清单/)
  })

  test('Given loader 包存在但未引用随包 addon When 校验 Then 阻止发布', () => {
    const resources = makeResources('linux', 'x64')
    writeFileSync(
      join(resources, 'local-runtime/cli/node_modules/@napi-rs/keyring/index.js'),
      'module.exports = {}\n',
    )
    expect(() => verifyLocalRuntimeResources(resources, 'linux', undefined, 'x64'))
      .toThrow(/loader 未引用目标 addon/)
  })

  test('Given 临时 Runtime 校验失败 When 尝试发布 Then 保留原有可用 Runtime', () => {
    const installedResources = makeResources('darwin', 'arm64')
    const stagedResources = makeResources('darwin', 'arm64')
    const installedEntry = join(installedResources, 'local-runtime/cli/cli.js')
    const installedBefore = readFileSync(installedEntry, 'utf8')
    rmSync(
      join(stagedResources, 'local-runtime/cli/node_modules/@napi-rs/keyring'),
      { recursive: true },
    )

    expect(() => promoteVerifiedLocalRuntime({
      stagedResourcesRoot: stagedResources,
      installedResourcesRoot: installedResources,
      platform: 'darwin',
      arch: 'arm64',
    })).toThrow(/keyring loader 清单/)
    expect(readFileSync(installedEntry, 'utf8')).toBe(installedBefore)
  })

  test('Given 旧 Runtime 移入备份失败 When 尝试发布 Then 不删除仍在原位的旧目录', () => {
    const installedResources = makeResources('darwin', 'arm64')
    const stagedResources = makeResources('darwin', 'arm64')
    const installedEntry = join(installedResources, 'local-runtime/cli/cli.js')
    const installedBefore = readFileSync(installedEntry, 'utf8')

    expect(() => promoteVerifiedLocalRuntime({
      stagedResourcesRoot: stagedResources,
      installedResourcesRoot: installedResources,
      platform: 'darwin',
      arch: 'arm64',
      fileOperations: {
        exists: existsSync,
        rename: () => { throw new Error('注入：备份 rename 失败') },
        remove: path => rmSync(path, { recursive: true, force: true }),
      },
    })).toThrow(/备份 rename 失败/)
    expect(readFileSync(installedEntry, 'utf8')).toBe(installedBefore)
    expect(existsSync(join(stagedResources, 'local-runtime'))).toBe(true)
  })

  test('Given 旧 Runtime 已备份但临时目录提升失败 When 回滚 Then 恢复旧目录', () => {
    const installedResources = makeResources('darwin', 'arm64')
    const stagedResources = makeResources('darwin', 'arm64')
    const installedEntry = join(installedResources, 'local-runtime/cli/cli.js')
    const installedBefore = readFileSync(installedEntry, 'utf8')
    let renameCount = 0

    expect(() => promoteVerifiedLocalRuntime({
      stagedResourcesRoot: stagedResources,
      installedResourcesRoot: installedResources,
      platform: 'darwin',
      arch: 'arm64',
      fileOperations: {
        exists: existsSync,
        rename: (source, target) => {
          renameCount += 1
          if (renameCount === 2) throw new Error('注入：提升 rename 失败')
          renameSync(source, target)
        },
        remove: path => rmSync(path, { recursive: true, force: true }),
      },
    })).toThrow(/提升 rename 失败/)
    expect(renameCount).toBe(3)
    expect(readFileSync(installedEntry, 'utf8')).toBe(installedBefore)
    expect(existsSync(join(stagedResources, 'local-runtime'))).toBe(true)
  })

  test('Given macOS App Bundle When 校验打包产物 Then 使用 Contents\/Resources', () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'xcodes-app-out-'))
    temporaryDirectories.push(appOutDir)
    const resources = resolvePackagedResourcesRoot(appOutDir, 'darwin')
    const source = makeResources('darwin', 'arm64')
    mkdirSync(dirname(resources), { recursive: true })
    renameDirectory(source, resources)
    expect(verifyPackagedLocalRuntime(appOutDir, 'darwin', undefined, 'arm64').resourcesRoot).toBe(resources)
  })
})

function renameDirectory(source: string, target: string): void {
  renameSync(source, target)
  const index = temporaryDirectories.indexOf(source)
  if (index >= 0) temporaryDirectories.splice(index, 1)
}

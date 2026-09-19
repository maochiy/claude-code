#!/usr/bin/env bun
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import pkg from '../package.json' with { type: 'json' }
import {
  assertBundledBunBinary,
  getSessionCliWrapperName,
  getSessionCliWrapperSource,
  isSessionCliHelpSuccessful,
  promoteVerifiedLocalRuntime,
  type ElectronBuilderPlatform,
  type RuntimeArchitecture,
} from './local-runtime-artifacts'

const appRoot = resolve(import.meta.dir, '..')
const repositoryRoot = resolve(appRoot, '../..')
const resourcesRoot = join(appRoot, 'resources')
const runtimeRoot = join(resourcesRoot, 'local-runtime')
const temporaryResourcesRoot = join(resourcesRoot, `.local-runtime-${process.pid}`)
const temporaryRoot = join(temporaryResourcesRoot, 'local-runtime')
const expectedBunVersion = pkg.proma.bun.version
const reuseCliDist = process.argv.includes('--reuse-cli-dist')
let stagedBunPath = ''

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function targetPlatform(): ElectronBuilderPlatform {
  const value = readOption('--platform') || process.platform
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`不支持的目标平台: ${value}`)
}

function targetArchitecture(): RuntimeArchitecture {
  const value = readOption('--arch') || process.arch
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`不支持的目标架构: ${value}`)
}

const runtimePlatform = targetPlatform()
const runtimeArch = targetArchitecture()
const platformArch = `${runtimePlatform}-${runtimeArch}`
const isCurrentTarget = runtimePlatform === process.platform && runtimeArch === process.arch

function resolveCliRoot(): string {
  const candidates = [
    process.env.XCODES_CLI_SOURCE_ROOT,
    resolve(repositoryRoot, '..'),
    resolve(repositoryRoot, '..', 'claude-code'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of [...new Set(candidates)]) {
    if (
      existsSync(join(candidate, 'package.json'))
      && existsSync(join(candidate, 'src', 'entrypoints', 'cli.tsx'))
    ) {
      return candidate
    }
  }
  throw new Error(`未找到固定自有 CLI 源码，已检查：${candidates.join('、')}`)
}

const cliRoot = resolveCliRoot()

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 执行失败（退出码 ${result.status ?? 'unknown'}）`)
  }
}

function readVersion(command: string): string {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`无法执行 Bun: ${command}`)
  return result.stdout.trim()
}

function stageBundledBun(): void {
  const binaryName = runtimePlatform === 'win32' ? 'bun.exe' : 'bun'
  const target = join(appRoot, 'vendor', 'bun', platformArch, binaryName)
  if (isCurrentTarget) {
    const currentVersion = readVersion(process.execPath)
    if (currentVersion !== expectedBunVersion) {
      throw new Error(
        `构建 Bun 版本为 ${currentVersion}，固定 Runtime 要求 ${expectedBunVersion}。请切换到固定版本后重试。`,
      )
    }
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(process.execPath, target)
    if (runtimePlatform !== 'win32') chmodSync(target, 0o755)
    if (readVersion(target) !== expectedBunVersion) throw new Error(`内置 Bun 校验失败: ${target}`)
  }
  assertBundledBunBinary(target, runtimePlatform, runtimeArch, expectedBunVersion)
  stagedBunPath = target
}

function expectedKeyringFileNames(): string[] {
  if (runtimePlatform === 'win32') return [`keyring.win32-${runtimeArch}-msvc.node`]
  if (runtimePlatform === 'linux') {
    return [
      `keyring.linux-${runtimeArch}-gnu.node`,
      `keyring.linux-${runtimeArch}-musl.node`,
    ]
  }
  return [`keyring.darwin-${runtimeArch}.node`]
}

function isCurrentLinuxMusl(): boolean {
  if (runtimePlatform !== 'linux' || !isCurrentTarget) return false
  try {
    return readFileSync('/usr/bin/ldd', 'utf8').includes('musl')
  } catch {
    const report = process.report?.getReport() as {
      header?: { glibcVersionRuntime?: unknown }
    } | undefined
    return !report?.header?.glibcVersionRuntime
  }
}

function currentTargetKeyringPackageName(): string {
  if (runtimePlatform === 'win32') return `@napi-rs/keyring-win32-${runtimeArch}-msvc`
  if (runtimePlatform === 'linux') {
    return `@napi-rs/keyring-linux-${runtimeArch}-${isCurrentLinuxMusl() ? 'musl' : 'gnu'}`
  }
  return `@napi-rs/keyring-darwin-${runtimeArch}`
}

function resolveTargetKeyringAddon(loaderSourceRoot: string): string {
  const override = process.env.XCODES_KEYRING_NATIVE_PATH?.trim()
  if (override) {
    if (!existsSync(override) || !statSync(override).isFile()) {
      throw new Error(`XCODES_KEYRING_NATIVE_PATH 不是有效文件: ${override}`)
    }
    return override
  }
  if (!isCurrentTarget) {
    throw new Error(`跨目标构建 ${platformArch} 需要 XCODES_KEYRING_NATIVE_PATH 指向已校验的目标 keyring addon`)
  }
  const resolveFromLoader = createRequire(join(loaderSourceRoot, 'index.js'))
  return resolveFromLoader.resolve(currentTargetKeyringPackageName())
}

function stageKeyringRuntimeDependencies(): void {
  const installedLoader = join(cliRoot, 'node_modules', '@napi-rs', 'keyring')
  if (!existsSync(installedLoader)) {
    throw new Error(`CLI 缺少固定 @napi-rs/keyring loader 包: ${installedLoader}`)
  }
  const loaderSourceRoot = realpathSync(installedLoader)
  const addonSource = resolveTargetKeyringAddon(loaderSourceRoot)
  const allowedNames = expectedKeyringFileNames()
  const sourceName = basename(addonSource)
  const targetName = runtimePlatform === 'linux'
    ? sourceName
    : allowedNames[0]!
  if (!allowedNames.includes(targetName)) {
    throw new Error(
      `目标 keyring addon 文件名必须是 ${allowedNames.join(' 或 ')}，实际：${sourceName}`,
    )
  }

  const loaderTargetRoot = join(temporaryRoot, 'cli', 'node_modules', '@napi-rs', 'keyring')
  cpSync(loaderSourceRoot, loaderTargetRoot, { recursive: true, dereference: true })
  for (const name of readdirSync(loaderTargetRoot)) {
    if (/^keyring\..+\.node$/.test(name)) rmSync(join(loaderTargetRoot, name), { force: true })
  }
  copyFileSync(addonSource, join(loaderTargetRoot, targetName))
}

function buildCli(): string {
  const manifestPath = join(cliRoot, 'package.json')
  const entry = join(cliRoot, 'src', 'entrypoints', 'cli.tsx')
  if (!existsSync(manifestPath) || !existsSync(entry)) {
    throw new Error(`未找到固定自有 CLI 源码: ${cliRoot}`)
  }
  if (reuseCliDist) {
    console.log('[本地 Runtime] 复用现有 CLI dist（仅用于只读构建环境）')
  } else {
    run(process.execPath, ['run', 'build'], cliRoot)
  }
  run(process.execPath, ['run', 'scripts/check-bundle-integrity.ts', 'dist'], cliRoot)
  const cliDist = join(cliRoot, 'dist')
  if (!existsSync(join(cliDist, 'cli.js'))) throw new Error(`CLI 构建缺少 dist/cli.js: ${cliDist}`)
  cpSync(cliDist, join(temporaryRoot, 'cli'), { recursive: true })
  return (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }).version
}

function buildService(): void {
  const entry = join(repositoryRoot, 'apps', 'local-service', 'src', 'index.ts')
  if (!existsSync(entry)) throw new Error(`未找到本地服务入口: ${entry}`)
  const serviceRoot = join(temporaryRoot, 'service')
  mkdirSync(serviceRoot, { recursive: true })
  run(
    process.execPath,
    ['build', '--target=bun', '--sourcemap=linked', '--outdir', serviceRoot, entry],
    repositoryRoot,
  )
}

function buildSessionCli(): void {
  const entry = join(repositoryRoot, 'apps', 'cli', 'src', 'index.ts')
  if (!existsSync(entry)) throw new Error(`未找到会话辅助 CLI 入口: ${entry}`)
  const sessionCliRoot = join(temporaryRoot, 'session-cli')
  mkdirSync(sessionCliRoot, { recursive: true })
  run(
    process.execPath,
    ['build', '--target=bun', '--outdir', sessionCliRoot, entry],
    repositoryRoot,
  )

  const wrapper = join(sessionCliRoot, getSessionCliWrapperName(runtimePlatform))
  writeFileSync(wrapper, getSessionCliWrapperSource(runtimePlatform))
  if (runtimePlatform !== 'win32') chmodSync(wrapper, 0o755)
}

function smokeSessionCli(bunPath: string, entry: string): void {
  const result = spawnSync(bunPath, [entry, '--help'], { encoding: 'utf8' })
  if (!isSessionCliHelpSuccessful(result.status, result.stdout, result.stderr)) {
    throw new Error(`会话辅助 CLI --help 校验失败：${result.stderr || result.stdout}`)
  }
}

function main(): void {
  rmSync(temporaryResourcesRoot, { recursive: true, force: true })
  mkdirSync(temporaryRoot, { recursive: true })
  try {
    const cliVersion = buildCli()
    stageKeyringRuntimeDependencies()
    buildService()
    buildSessionCli()
    writeFileSync(
      join(temporaryRoot, 'package.json'),
      `${JSON.stringify({ name: '@xcodes/local-runtime', private: true, version: cliVersion, bun: expectedBunVersion }, null, 2)}\n`,
    )
    stageBundledBun()
    const verification = promoteVerifiedLocalRuntime({
      stagedResourcesRoot: temporaryResourcesRoot,
      installedResourcesRoot: resourcesRoot,
      platform: runtimePlatform,
      arch: runtimeArch,
      bunOverride: stagedBunPath,
      beforePromote: (stagedVerification) => {
        if (isCurrentTarget) smokeSessionCli(stagedBunPath, stagedVerification.sessionCliEntry)
        else console.log(`[本地 Runtime] ${platformArch} 为跨目标产物，仅完成静态校验，不在本机执行`)
      },
    })
    rmSync(temporaryResourcesRoot, { recursive: true, force: true })
    console.log(`[本地 Runtime] 已生成 ${runtimeRoot}`)
    console.log(`[本地 Runtime] CLI ${cliVersion}（${verification.cliJavaScriptFiles} 个 JS 文件）/ Bun ${expectedBunVersion} / ${basename(join(runtimeRoot, 'service', 'index.js'))}`)
    console.log(
      isCurrentTarget
        ? `[本地 Runtime] 会话辅助 CLI --help 通过: ${verification.sessionCliWrapper}`
        : `[本地 Runtime] 会话辅助 CLI wrapper 静态校验通过: ${verification.sessionCliWrapper}`,
    )
  } catch (error) {
    rmSync(temporaryResourcesRoot, { recursive: true, force: true })
    throw error
  }
}

main()

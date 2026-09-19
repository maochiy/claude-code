import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'

export type ElectronBuilderPlatform = 'darwin' | 'linux' | 'win32'
export type RuntimeArchitecture = 'arm64' | 'x64'

export interface LocalRuntimeVerification {
  bunPath: string
  cliEntry: string
  cliJavaScriptFiles: number
  resourcesRoot: string
  sessionCliEntry: string
  sessionCliWrapper: string
  serviceEntry: string
  target: `${ElectronBuilderPlatform}-${RuntimeArchitecture}`
}

export function getSessionCliWrapperName(platform: ElectronBuilderPlatform): string {
  return platform === 'win32' ? 'proma.cmd' : 'proma'
}

export function getSessionCliWrapperSource(platform: ElectronBuilderPlatform): string {
  if (platform === 'win32') {
    return '@echo off\r\n"%~dp0..\\..\\vendor\\bun\\bun.exe" "%~dp0index.js" %*\r\n'
  }
  return '#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$SCRIPT_DIR/../../vendor/bun/bun" "$SCRIPT_DIR/index.js" "$@"\n'
}

export function isSessionCliHelpSuccessful(
  status: number | null,
  stdout: string,
  stderr: string,
): boolean {
  return status === 0 && `${stdout}\n${stderr}`.includes('Proma 会话渐进式读取 CLI')
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...listFiles(path))
    else if (stat.isFile()) files.push(path)
  }
  return files
}

function assertNonEmptyFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`本地 Runtime 缺少 ${label}: ${path}`)
  }
}

function assertNonEmptyDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory() || listFiles(path).length === 0) {
    throw new Error(`本地 Runtime 缺少 ${label}: ${path}`)
  }
}

function assertSessionCliWrapper(path: string, platform: ElectronBuilderPlatform): void {
  assertNonEmptyFile(path, '会话辅助 CLI wrapper')
  if (readFileSync(path, 'utf8') !== getSessionCliWrapperSource(platform)) {
    throw new Error(`会话辅助 CLI wrapper 内容不符合固定启动协议: ${path}`)
  }
  if (platform !== 'win32' && (statSync(path).mode & 0o111) === 0) {
    throw new Error(`会话辅助 CLI wrapper 不可执行: ${path}`)
  }
}

function hasPrefix(buffer: Buffer, prefix: number[]): boolean {
  return prefix.every((value, index) => buffer[index] === value)
}

function assertNativeArchitecture(
  binary: Buffer,
  path: string,
  platform: ElectronBuilderPlatform,
  arch: RuntimeArchitecture,
  label: string,
): void {
  let matches = false
  if (platform === 'darwin' && binary.length >= 8) {
    const cpuType = binary.readUInt32LE(4)
    matches = cpuType === (arch === 'arm64' ? 0x0100000c : 0x01000007)
  } else if (platform === 'linux' && binary.length >= 20) {
    const machine = binary.readUInt16LE(18)
    matches = machine === (arch === 'arm64' ? 0x00b7 : 0x003e)
  } else if (platform === 'win32' && binary.length >= 64) {
    const peOffset = binary.readUInt32LE(0x3c)
    if (peOffset + 6 <= binary.length && binary.subarray(peOffset, peOffset + 4).equals(Buffer.from('PE\0\0'))) {
      const machine = binary.readUInt16LE(peOffset + 4)
      matches = machine === (arch === 'arm64' ? 0xaa64 : 0x8664)
    }
  }
  if (!matches) throw new Error(`${label} 架构不是 ${platform}-${arch}: ${path}`)
}

/**
 * 对跨平台 Bun 做静态校验。构建机无法执行其他系统的二进制，
 * 因此同时检查目标格式魔数和二进制内嵌的固定版本号。
 */
export function assertBundledBunBinary(
  path: string,
  platform: ElectronBuilderPlatform,
  arch: RuntimeArchitecture,
  expectedVersion: string,
): void {
  assertNonEmptyFile(path, 'Bun 可执行文件')
  const binary = readFileSync(path)
  const hasExpectedFormat = platform === 'win32'
    ? hasPrefix(binary, [0x4d, 0x5a])
    : platform === 'linux'
      ? hasPrefix(binary, [0x7f, 0x45, 0x4c, 0x46])
      : hasPrefix(binary, [0xcf, 0xfa, 0xed, 0xfe])
        || hasPrefix(binary, [0xfe, 0xed, 0xfa, 0xcf])

  if (!hasExpectedFormat) throw new Error(`内置 Bun 不是有效的 ${platform} 可执行文件: ${path}`)
  assertNativeArchitecture(binary, path, platform, arch, '内置 Bun')
  if (!binary.includes(Buffer.from(expectedVersion))) {
    throw new Error(`内置 Bun 不包含固定版本 ${expectedVersion}: ${path}`)
  }
}

function expectedKeyringNames(platform: ElectronBuilderPlatform, arch: RuntimeArchitecture): string[] {
  if (platform === 'win32') return [`keyring.win32-${arch}-msvc.node`]
  if (platform === 'linux') {
    return [
      `keyring.linux-${arch}-gnu.node`,
      `keyring.linux-${arch}-musl.node`,
    ]
  }
  return [`keyring.darwin-${arch}.node`]
}

function assertTargetKeyringAddon(
  cliRoot: string,
  platform: ElectronBuilderPlatform,
  arch: RuntimeArchitecture,
): void {
  const packageRoot = join(cliRoot, 'node_modules', '@napi-rs', 'keyring')
  const manifestPath = join(packageRoot, 'package.json')
  assertNonEmptyFile(manifestPath, '@napi-rs/keyring loader 清单')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name?: unknown
    main?: unknown
  }
  if (manifest.name !== '@napi-rs/keyring' || typeof manifest.main !== 'string') {
    throw new Error(`本地 Runtime CLI 的 @napi-rs/keyring loader 清单无效: ${manifestPath}`)
  }
  const loaderPath = resolveRelativeModule(manifestPath, `./${manifest.main}`)
  if (!loaderPath) {
    throw new Error(`本地 Runtime CLI 的 @napi-rs/keyring loader 入口缺失: ${manifest.main}`)
  }

  const expectedNames = expectedKeyringNames(platform, arch)
  const addons = listFiles(packageRoot).filter((path) => /^keyring\..+\.node$/.test(basename(path)))
  const matching = addons.filter((path) => expectedNames.includes(basename(path)))
  if (matching.length !== 1 || addons.length !== 1) {
    throw new Error(
      `本地 Runtime CLI 必须且只能携带 ${expectedNames.join(' 或 ')} addon，实际：${addons.map(path => basename(path)).join('、') || '无'}`,
    )
  }

  const addon = matching[0]!
  assertNativeArchitecture(readFileSync(addon), addon, platform, arch, 'keyring addon')
  const loaderSource = readFileSync(loaderPath, 'utf8')
  const requireNeedle = `./${basename(addon)}`
  if (!loaderSource.includes(requireNeedle)) {
    throw new Error(`@napi-rs/keyring loader 未引用目标 addon: ${requireNeedle}`)
  }
}

function resolveRelativeModule(importer: string, specifier: string): string | null {
  const base = resolve(dirname(importer), specifier)
  const candidates = [base, `${base}.js`, `${base}.json`, join(base, 'index.js')]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** 校验 splitting 构建中的相对 JS 引用，避免安装包只带 cli.js 而漏掉 chunks。 */
function assertCliModuleGraph(cliRoot: string): number {
  const javaScriptFiles = listFiles(cliRoot).filter((path) => extname(path) === '.js')
  const nodeModulesRoot = join(cliRoot, 'node_modules') + sep
  const bundleJavaScriptFiles = javaScriptFiles.filter(
    path => !path.startsWith(nodeModulesRoot),
  )
  if (bundleJavaScriptFiles.length < 2) {
    throw new Error(`本地 Runtime CLI 构建不完整：仅找到 ${bundleJavaScriptFiles.length} 个 JS 文件`)
  }

  const importPatterns = [
    /(?:from\s+|import\s*\()\s*["'](\.\.?\/[^"']+)["']/g,
    /\bimport\s*["'](\.\.?\/[^"']+)["']/g,
  ]
  const missing = new Set<string>()
  for (const file of bundleJavaScriptFiles) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of importPatterns) {
      pattern.lastIndex = 0
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]
        if (specifier && !resolveRelativeModule(file, specifier)) {
          missing.add(`${file.slice(cliRoot.length + 1)} -> ${specifier}`)
        }
      }
    }
  }
  if (missing.size > 0) {
    throw new Error(`本地 Runtime CLI 存在断裂引用：${[...missing].slice(0, 8).join('、')}`)
  }

  const keyringReferenced = bundleJavaScriptFiles.some((file) =>
    readFileSync(file, 'utf8').includes('@napi-rs/keyring'))
  if (!keyringReferenced) {
    throw new Error('本地 Runtime CLI 未保留 external @napi-rs/keyring 引用')
  }
  return bundleJavaScriptFiles.length
}

export function resolvePackagedResourcesRoot(
  appOutDir: string,
  electronPlatformName: ElectronBuilderPlatform,
  productName = 'Xcodes',
): string {
  return electronPlatformName === 'darwin'
    ? join(appOutDir, `${productName}.app`, 'Contents', 'Resources')
    : join(appOutDir, 'resources')
}

export function verifyLocalRuntimeResources(
  resourcesRoot: string,
  platform: ElectronBuilderPlatform,
  bunOverride?: string,
  arch: RuntimeArchitecture = process.arch === 'x64' ? 'x64' : 'arm64',
): LocalRuntimeVerification {
  const runtimeRoot = join(resourcesRoot, 'local-runtime')
  const cliRoot = join(runtimeRoot, 'cli')
  const cliEntry = join(cliRoot, 'cli.js')
  const sessionCliRoot = join(runtimeRoot, 'session-cli')
  const sessionCliEntry = join(sessionCliRoot, 'index.js')
  const sessionCliWrapper = join(sessionCliRoot, getSessionCliWrapperName(platform))
  const serviceEntry = join(runtimeRoot, 'service', 'index.js')
  const bunPath = bunOverride || join(resourcesRoot, 'vendor', 'bun', platform === 'win32' ? 'bun.exe' : 'bun')

  const manifestPath = join(runtimeRoot, 'package.json')
  assertNonEmptyFile(manifestPath, '版本清单')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bun?: unknown }
  if (typeof manifest.bun !== 'string' || manifest.bun.length === 0) {
    throw new Error(`本地 Runtime 版本清单缺少固定 Bun 版本: ${manifestPath}`)
  }

  assertNonEmptyFile(cliEntry, 'CLI 入口')
  assertNonEmptyDirectory(join(cliRoot, 'vendor', 'audio-capture'), 'CLI audio-capture 资源')
  assertNonEmptyDirectory(join(cliRoot, 'vendor', 'ripgrep'), 'CLI ripgrep 资源')
  assertNonEmptyFile(sessionCliEntry, '会话辅助 CLI 入口')
  assertSessionCliWrapper(sessionCliWrapper, platform)
  assertNonEmptyFile(serviceEntry, '本地服务入口')
  assertBundledBunBinary(bunPath, platform, arch, manifest.bun)
  assertTargetKeyringAddon(cliRoot, platform, arch)

  return {
    bunPath,
    cliEntry,
    cliJavaScriptFiles: assertCliModuleGraph(cliRoot),
    resourcesRoot,
    sessionCliEntry,
    sessionCliWrapper,
    serviceEntry,
    target: `${platform}-${arch}`,
  }
}

export interface PromoteLocalRuntimeOptions {
  stagedResourcesRoot: string
  installedResourcesRoot: string
  platform: ElectronBuilderPlatform
  arch: RuntimeArchitecture
  bunOverride?: string
  beforePromote?: (verification: LocalRuntimeVerification) => void
  fileOperations?: PromoteLocalRuntimeFileOperations
}

export interface PromoteLocalRuntimeFileOperations {
  exists: (path: string) => boolean
  rename: (source: string, target: string) => void
  remove: (path: string) => void
}

/**
 * 临时产物完整校验（含可选 smoke）通过后才替换已安装 Runtime。
 * 替换或二次校验失败时恢复旧目录，避免一次坏构建清掉可用产物。
 */
export function promoteVerifiedLocalRuntime(
  options: PromoteLocalRuntimeOptions,
): LocalRuntimeVerification {
  const stagedVerification = verifyLocalRuntimeResources(
    options.stagedResourcesRoot,
    options.platform,
    options.bunOverride,
    options.arch,
  )
  options.beforePromote?.(stagedVerification)

  const stagedRuntimeRoot = join(options.stagedResourcesRoot, 'local-runtime')
  const installedRuntimeRoot = join(options.installedResourcesRoot, 'local-runtime')
  const backupRuntimeRoot = `${installedRuntimeRoot}.backup-${process.pid}`
  const fileOperations = options.fileOperations ?? {
    exists: existsSync,
    rename: renameSync,
    remove: (path: string) => rmSync(path, { recursive: true, force: true }),
  }
  const hadInstalledRuntime = fileOperations.exists(installedRuntimeRoot)
  fileOperations.remove(backupRuntimeRoot)
  let backupMoved = false
  let stagedPromoted = false
  let installedVerification: LocalRuntimeVerification

  try {
    if (hadInstalledRuntime) {
      fileOperations.rename(installedRuntimeRoot, backupRuntimeRoot)
      backupMoved = true
    }
    fileOperations.rename(stagedRuntimeRoot, installedRuntimeRoot)
    stagedPromoted = true
    installedVerification = verifyLocalRuntimeResources(
      options.installedResourcesRoot,
      options.platform,
      options.bunOverride,
      options.arch,
    )
  } catch (error) {
    if (stagedPromoted) fileOperations.remove(installedRuntimeRoot)
    if (backupMoved && fileOperations.exists(backupRuntimeRoot)) {
      fileOperations.rename(backupRuntimeRoot, installedRuntimeRoot)
    }
    throw error
  }

  if (backupMoved) fileOperations.remove(backupRuntimeRoot)
  return installedVerification
}

export function verifyPackagedLocalRuntime(
  appOutDir: string,
  electronPlatformName: ElectronBuilderPlatform,
  productName?: string,
  arch: RuntimeArchitecture = process.arch === 'x64' ? 'x64' : 'arm64',
): LocalRuntimeVerification {
  return verifyLocalRuntimeResources(
    resolvePackagedResourcesRoot(appOutDir, electronPlatformName, productName),
    electronPlatformName,
    undefined,
    arch,
  )
}

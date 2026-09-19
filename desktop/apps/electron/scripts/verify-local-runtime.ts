#!/usr/bin/env bun
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  verifyLocalRuntimeResources,
  verifyPackagedLocalRuntime,
  type ElectronBuilderPlatform,
  type RuntimeArchitecture,
} from './local-runtime-artifacts'

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function platform(value?: string): ElectronBuilderPlatform {
  const target = value || process.platform
  if (target === 'darwin' || target === 'linux' || target === 'win32') return target
  throw new Error(`不支持的平台: ${target}`)
}

function architecture(value?: string): RuntimeArchitecture {
  const target = value || process.arch
  if (target === 'arm64' || target === 'x64') return target
  throw new Error(`不支持的架构: ${target}`)
}

const appOutDir = readOption('--app-out-dir')
const targetPlatform = platform(readOption('--platform'))
const targetArch = architecture(readOption('--arch'))
const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const binaryName = targetPlatform === 'win32' ? 'bun.exe' : 'bun'
const sourceBun = resolve(appRoot, 'vendor', 'bun', `${targetPlatform}-${targetArch}`, binaryName)
const result = appOutDir
  ? verifyPackagedLocalRuntime(
      resolve(appOutDir),
      targetPlatform,
      readOption('--product-name'),
      targetArch,
    )
  : verifyLocalRuntimeResources(
      resolve(readOption('--resources-root') || fileURLToPath(new URL('../resources', import.meta.url))),
      targetPlatform,
      readOption('--bun-path') ? resolve(readOption('--bun-path')!) : sourceBun,
      targetArch,
    )

console.log(`[本地 Runtime] 静态完整性校验通过：${result.cliJavaScriptFiles} 个 CLI JS 文件`)
console.log(`[本地 Runtime] CLI: ${result.cliEntry}`)
console.log(`[本地 Runtime] Service: ${result.serviceEntry}`)
console.log(`[本地 Runtime] Session CLI: ${result.sessionCliWrapper}`)
console.log(`[本地 Runtime] Bun: ${result.bunPath}`)

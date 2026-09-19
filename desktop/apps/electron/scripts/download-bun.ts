#!/usr/bin/env bun
/**
 * Bun 二进制下载脚本
 *
 * 功能：
 * - 从 GitHub releases 下载指定版本的 Bun 二进制文件
 * - 支持所有目标平台（darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64）
 * - 记录下载包 SHA256，并校验解压后二进制的目标格式与固定版本
 * - 解压到 vendor/bun/{platform-arch}/ 目录
 *
 * 使用：
 * bun run scripts/download-bun.ts [--platform <platform-arch> | --current] [--force]
 *
 * 选项：
 * --platform: 只下载指定平台（默认下载所有平台）
 * --current: 只下载当前平台架构
 * --force: 强制重新下载（即使已存在）
 */

import { existsSync, mkdirSync, chmodSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import type { PlatformArch, BunDownloadInfo } from '@proma/shared'
import {
  assertBundledBunBinary,
  type ElectronBuilderPlatform,
  type RuntimeArchitecture,
} from './local-runtime-artifacts'

/** Bun 下载 URL 基础路径 */
const BUN_DOWNLOAD_BASE = 'https://github.com/oven-sh/bun/releases/download'

/** 平台架构映射表（Node.js 命名 -> Bun releases 命名）*/
const PLATFORM_ARCH_MAP: Record<PlatformArch, string> = {
  'darwin-arm64': 'darwin-aarch64',
  'darwin-x64': 'darwin-x64',
  'linux-arm64': 'linux-aarch64',
  'linux-x64': 'linux-x64',
  'win32-x64': 'windows-x64',
}

/** 支持的目标平台列表 */
const TARGET_PLATFORMS: PlatformArch[] = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
]

/** 脚本所在目录 */
const SCRIPT_DIR = dirname(Bun.main)
/** vendor 目录路径 */
const VENDOR_DIR = join(SCRIPT_DIR, '..', 'vendor', 'bun')

/**
 * 获取 Bun 下载信息
 */
function getBunDownloadInfo(version: string, platformArch: PlatformArch): BunDownloadInfo {
  const bunPlatform = PLATFORM_ARCH_MAP[platformArch]
  const isWindows = platformArch.startsWith('win32')
  const binaryName = isWindows ? 'bun.exe' : 'bun'
  const zipFileName = `bun-${bunPlatform}.zip`

  return {
    platformArch,
    url: `${BUN_DOWNLOAD_BASE}/bun-v${version}/${zipFileName}`,
    zipFileName,
    binaryName,
  }
}

/**
 * 下载文件到指定路径
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  console.log(`  下载中: ${url}`)

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Proma-Build-Script/1.0',
    },
    redirect: 'follow',
  })

  if (!response.ok) {
    throw new Error(`下载失败: ${response.status} ${response.statusText}`)
  }

  // 确保目标目录存在
  const dir = dirname(destPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  // 使用 Bun.write 写入文件
  const arrayBuffer = await response.arrayBuffer()
  await Bun.write(destPath, arrayBuffer)

  console.log(`  已保存到: ${destPath}`)
}

/**
 * 计算文件的 SHA256 校验和
 */
async function calculateChecksum(filePath: string): Promise<string> {
  const file = Bun.file(filePath)
  const buffer = await file.arrayBuffer()
  const hash = createHash('sha256')
  hash.update(Buffer.from(buffer))
  return hash.digest('hex')
}

/**
 * 解压 zip 文件
 */
async function extractZip(zipPath: string, destDir: string, binaryName: string): Promise<string> {
  console.log(`  解压中: ${zipPath}`)

  // 确保目标目录存在
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true })
  }

  // 使用 Bun.spawn 调用 unzip 命令
  const proc = Bun.spawn(['unzip', '-o', '-j', zipPath, '-d', destDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`解压失败: ${stderr}`)
  }

  const binaryPath = join(destDir, binaryName)

  // 设置可执行权限（非 Windows）
  if (!binaryName.endsWith('.exe')) {
    chmodSync(binaryPath, 0o755)
  }

  console.log(`  已解压到: ${destDir}`)
  return binaryPath
}

/**
 * 验证 Bun 二进制文件。当前平台额外执行 --version，跨平台产物采用格式与内嵌版本静态校验。
 */
async function validateBunBinary(
  binaryPath: string,
  platformArch: PlatformArch,
  expectedVersion: string,
): Promise<boolean> {
  const platform = platformArch.split('-')[0] as ElectronBuilderPlatform
  const arch = platformArch.split('-')[1] as RuntimeArchitecture
  try {
    assertBundledBunBinary(binaryPath, platform, arch, expectedVersion)
    if (`${process.platform}-${process.arch}` !== platformArch) return true

    const proc = Bun.spawn([binaryPath, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const exitCode = await proc.exited
    if (exitCode !== 0) return false

    const version = await new Response(proc.stdout).text()
    return version.trim() === expectedVersion
  } catch {
    return false
  }
}

/**
 * 下载并安装单个平台的 Bun
 */
async function downloadBunForPlatform(
  version: string,
  platformArch: PlatformArch,
  force: boolean
): Promise<void> {
  console.log(`\n[${platformArch}] 开始处理...`)

  const info = getBunDownloadInfo(version, platformArch)
  const targetDir = join(VENDOR_DIR, platformArch)
  const binaryPath = join(targetDir, info.binaryName)

  // 检查是否已存在
  if (!force && existsSync(binaryPath)) {
    const isValid = await validateBunBinary(binaryPath, platformArch, version)
    if (isValid) {
      console.log(`  已存在正确版本 (${version})，跳过下载`)
      return
    }
    console.log('  已有二进制格式或版本不匹配，将重新下载')
  }

  // 创建临时目录
  const tempDir = join(VENDOR_DIR, '.temp', platformArch)
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true })
  }
  mkdirSync(tempDir, { recursive: true })

  const zipPath = join(tempDir, info.zipFileName)

  try {
    // 下载 zip 文件
    await downloadFile(info.url, zipPath)

    // 计算并显示校验和
    const checksum = await calculateChecksum(zipPath)
    console.log(`  SHA256: ${checksum}`)

    // 解压
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true })
    }
    await extractZip(zipPath, targetDir, info.binaryName)

    // 验证
    const isValid = await validateBunBinary(binaryPath, platformArch, version)
    if (!isValid) {
      throw new Error(`安装后验证失败：${platformArch} Bun 格式或版本不匹配`)
    }

    console.log(`  ✅ 安装成功: Bun ${version}`)
  } finally {
    // 清理临时文件
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true })
    }
  }
}

/**
 * 读取 package.json 中的 Bun 版本配置
 */
async function getBunVersion(): Promise<string> {
  const pkgPath = join(SCRIPT_DIR, '..', 'package.json')
  const pkgFile = Bun.file(pkgPath)
  const pkg = await pkgFile.json()

  const version = pkg.proma?.bun?.version
  if (!version) {
    throw new Error('package.json 中未配置 proma.bun.version')
  }

  return version
}

/**
 * 解析命令行参数
 */
function parseArgs(): { platforms: PlatformArch[]; force: boolean } {
  const args = process.argv.slice(2)
  let platforms: PlatformArch[] = [...TARGET_PLATFORMS]
  let force = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--current') {
      const current = `${process.platform}-${process.arch}` as PlatformArch
      if (!TARGET_PLATFORMS.includes(current)) {
        console.error(`错误：不支持当前平台 "${current}"`)
        process.exit(1)
      }
      platforms = [current]
    }
    if (arg === '--platform' && args[i + 1]) {
      const platform = args[i + 1] as PlatformArch
      if (!TARGET_PLATFORMS.includes(platform)) {
        console.error(`错误：不支持的平台 "${platform}"`)
        console.error(`支持的平台：${TARGET_PLATFORMS.join(', ')}`)
        process.exit(1)
      }
      platforms = [platform]
      i++
    } else if (arg === '--force') {
      force = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Bun 二进制下载脚本

用法：bun run scripts/download-bun.ts [选项]

选项：
  --platform <arch>  只下载指定平台（默认下载所有平台）
                     支持：${TARGET_PLATFORMS.join(', ')}
  --current          只下载当前平台架构
  --force           强制重新下载（即使已存在）
  --help, -h        显示帮助信息
`)
      process.exit(0)
    }
  }

  return { platforms, force }
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  console.log('='.repeat(60))
  console.log('Proma Bun 二进制下载脚本')
  console.log('='.repeat(60))

  try {
    const { platforms, force } = parseArgs()
    const version = await getBunVersion()

    console.log(`\nBun 版本: ${version}`)
    console.log(`目标平台: ${platforms.join(', ')}`)
    console.log(`强制下载: ${force ? '是' : '否'}`)
    console.log(`输出目录: ${VENDOR_DIR}`)

    // 确保 vendor 目录存在
    if (!existsSync(VENDOR_DIR)) {
      mkdirSync(VENDOR_DIR, { recursive: true })
    }

    // 下载每个平台
    for (const platform of platforms) {
      await downloadBunForPlatform(version, platform, force)
    }

    console.log('\n' + '='.repeat(60))
    console.log('✅ 所有 Bun 二进制下载完成')
    console.log('='.repeat(60))
  } catch (error) {
    console.error('\n❌ 下载失败:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

// 执行主函数
main()

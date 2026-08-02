import { cp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export type LinuxLibcFamily = 'glibc' | 'musl'

const rootRequire = createRequire(import.meta.url)
const sharpPackageJsonPath = rootRequire.resolve('sharp/package.json')
const sharpRequire = createRequire(sharpPackageJsonPath)

function detectLinuxLibcFamily(): LinuxLibcFamily {
  const report = process.report?.getReport()
  return report?.header.glibcVersionRuntime ? 'glibc' : 'musl'
}

/**
 * Sharp 的平台包命名与 Node 平台一致；Linux musl 需要额外的 musl 后缀。
 */
export function getSharpRuntimePackageNames(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  linuxLibcFamily: LinuxLibcFamily = detectLinuxLibcFamily(),
): string[] {
  const runtimePlatform =
    platform === 'linux'
      ? `linux${linuxLibcFamily === 'musl' ? 'musl' : ''}-${arch}`
      : `${platform}-${arch}`

  const sharpPackage = `@img/sharp-${runtimePlatform}`
  if (platform === 'win32') {
    return [sharpPackage]
  }

  return [sharpPackage, `@img/sharp-libvips-${runtimePlatform}`]
}

function resolveSharpDependencyDirectory(packageName: string): string {
  return dirname(sharpRequire.resolve(`${packageName}/package.json`))
}

/**
 * Bun 会把 Sharp 的 JavaScript 打进 chunk，但动态加载的 .node 与 libvips
 * 仍需按标准 node_modules 布局随桌面 Runtime 一起分发。
 */
export async function copySharpNativeDependencies(
  artifactDir: string,
): Promise<string[]> {
  const packageNames = getSharpRuntimePackageNames(
    process.platform,
    process.arch,
  )

  for (const packageName of packageNames) {
    const targetDir = join(
      artifactDir,
      'node_modules',
      ...packageName.split('/'),
    )
    await mkdir(dirname(targetDir), { recursive: true })
    await cp(resolveSharpDependencyDirectory(packageName), targetDir, {
      recursive: true,
      dereference: true,
    })
  }

  return packageNames
}

import {
  verifyPackagedLocalRuntime,
  type ElectronBuilderPlatform,
  type RuntimeArchitecture,
} from './local-runtime-artifacts'

interface ElectronBuilderAfterPackContext {
  appOutDir: string
  electronPlatformName: string
  arch: number
  packager: {
    appInfo: {
      productFilename: string
    }
  }
}

function architecture(value: number): RuntimeArchitecture {
  if (value === 1) return 'x64'
  if (value === 3) return 'arm64'
  throw new Error(`afterPack: 不支持的架构 ${value}`)
}

function platform(value: string): ElectronBuilderPlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`afterPack: 不支持的平台 ${value}`)
}

/** 任一执行资源缺失都应中断打包，不能产出启动后才报错的安装包。 */
export function ensurePackagedLocalRuntime(context: ElectronBuilderAfterPackContext): string {
  const result = verifyPackagedLocalRuntime(
    context.appOutDir,
    platform(context.electronPlatformName),
    context.packager.appInfo.productFilename,
    architecture(context.arch),
  )
  console.log(`[本地 Runtime] afterPack 校验通过：${result.cliJavaScriptFiles} 个 CLI JS 文件`)
  return result.resourcesRoot
}

export default function afterPack(context: ElectronBuilderAfterPackContext): void {
  ensurePackagedLocalRuntime(context)
}

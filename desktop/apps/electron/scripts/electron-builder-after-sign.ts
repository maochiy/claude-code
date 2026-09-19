import {
  verifyPackagedLocalRuntime,
  type ElectronBuilderPlatform,
  type RuntimeArchitecture,
} from './local-runtime-artifacts'

interface ElectronBuilderAfterSignContext {
  appOutDir: string
  electronPlatformName: string
  arch: number
  packager: { appInfo: { productFilename: string } }
}

function architecture(value: number): RuntimeArchitecture {
  if (value === 1) return 'x64'
  if (value === 3) return 'arm64'
  throw new Error(`afterSign: 不支持的架构 ${value}`)
}

function platform(value: string): ElectronBuilderPlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value
  throw new Error(`afterSign: 不支持的平台 ${value}`)
}

/** 正式签名后再次确认嵌套资源仍完整；只做静态检查，不执行目标架构文件。 */
export function verifyPackagedLocalRuntimeAfterSign(context: ElectronBuilderAfterSignContext): string {
  const result = verifyPackagedLocalRuntime(
    context.appOutDir,
    platform(context.electronPlatformName),
    context.packager.appInfo.productFilename,
    architecture(context.arch),
  )
  console.log(`[本地 Runtime] afterSign 校验通过：${result.resourcesRoot}`)
  return result.resourcesRoot
}

export default function afterSign(context: ElectronBuilderAfterSignContext): void {
  verifyPackagedLocalRuntimeAfterSign(context)
}

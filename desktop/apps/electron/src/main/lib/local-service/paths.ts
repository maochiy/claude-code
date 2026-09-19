import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface LocalRuntimePaths {
  serviceEntry: string
  cliEntry: string
  root: string
}

/** 开发只接受显式目录或同仓结构；正式包不访问开发机路径。 */
export function resolveLocalRuntimePaths(input: {
  appPath: string
  resourcesPath?: string
  packaged: boolean
  sourceRoot?: string
}): LocalRuntimePaths {
  if (input.packaged) {
    const root = join(input.resourcesPath || '', 'local-runtime')
    return { root, serviceEntry: join(root, 'service', 'index.js'), cliEntry: join(root, 'cli', 'cli.js') }
  }
  let root = resolve(input.sourceRoot || input.appPath)
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(root, 'src', 'entrypoints', 'cli.tsx')) && existsSync(join(root, 'desktop', 'apps', 'local-service'))) {
      const builtService = join(root, 'desktop', 'apps', 'local-service', 'dist', 'index.js')
      return {
        root,
        serviceEntry: existsSync(builtService) ? builtService : join(root, 'desktop', 'apps', 'local-service', 'src', 'index.ts'),
        cliEntry: join(root, 'dist', 'cli.js'),
      }
    }
    const parent = dirname(root)
    if (parent === root) break
    root = parent
  }
  throw new Error('未找到同仓 CLI：请从 claude-code/desktop 启动，或设置 XCODES_CLI_SOURCE_ROOT')
}

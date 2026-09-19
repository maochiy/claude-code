import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

/** 支持合仓 desktop 与迁移前相邻源码，CI 可显式覆盖。 */
export function resolveNativeCliRoot(): string {
  const desktopRoot = resolve(import.meta.dir, '../../../..')
  const candidates = process.env.XCODES_CLI_SOURCE_ROOT
    ? [resolve(process.env.XCODES_CLI_SOURCE_ROOT)]
    : [resolve(desktopRoot, '..'), resolve(desktopRoot, '../claude-code')]
  const root = candidates.find(candidate => existsSync(join(candidate, 'src/entrypoints/cli.tsx')))
  if (!root) throw new Error('未找到自有 CLI 源码，请指定 XCODES_CLI_SOURCE_ROOT 并先构建 CLI')
  return root
}

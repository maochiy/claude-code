import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/** 只授权调用方明确指定且真实存在的目录，合并软链接别名。 */
export function resolveAdditionalDirectories(directories: string[] | undefined, cwd?: string): string[] {
  return [...new Set((directories ?? []).map(directory => {
    const absolute = resolve(cwd ?? process.cwd(), directory)
    let canonical: string
    try {
      canonical = realpathSync(absolute)
      if (!statSync(canonical).isDirectory()) throw new Error('not directory')
    } catch {
      throw new Error(`附加目录不可用：${absolute}`)
    }
    return canonical
  }))].sort()
}

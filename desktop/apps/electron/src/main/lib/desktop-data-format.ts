import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DESKTOP_DATA_FORMAT = {
  schemaVersion: 2,
  runtime: 'local-cli',
  legacyHistory: 'display-only',
} as const

/** 仅标记桌面数据根，不修改任何旧 JSONL 或 CLI 原生 transcript。 */
export function ensureDesktopDataFormat(directory: string): void {
  const path = join(directory, 'desktop-data-format.json')
  try {
    writeFileSync(path, `${JSON.stringify(DESKTOP_DATA_FORMAT, null, 2)}\n`, { flag: 'wx' })
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('桌面数据版本记录损坏；原数据已保留，请修复后重试')
  }
  const format = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (format.schemaVersion !== DESKTOP_DATA_FORMAT.schemaVersion || format.runtime !== DESKTOP_DATA_FORMAT.runtime) {
    throw new Error('桌面数据版本不兼容；请使用匹配版本的应用，当前数据未修改')
  }
}

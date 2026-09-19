import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_DATA_FORMAT, ensureDesktopDataFormat } from './desktop-data-format'

const directories: string[] = []
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'xcodes-format-'))
  directories.push(directory)
  return directory
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

test('Given 旧 JSONL When 首次启用 Local CLI 数据格式 Then 仅新增版本且重复启动不改写历史', () => {
  const directory = fixture()
  const legacy = '{"runtime":"pi","content":"历史"}\n'
  writeFileSync(join(directory, 'legacy.jsonl'), legacy)
  ensureDesktopDataFormat(directory)
  ensureDesktopDataFormat(directory)
  expect(JSON.parse(readFileSync(join(directory, 'desktop-data-format.json'), 'utf8'))).toEqual(DESKTOP_DATA_FORMAT)
  expect(readFileSync(join(directory, 'legacy.jsonl'), 'utf8')).toBe(legacy)
})

test('Given 较新或损坏的数据格式 When 启动 Then 拒绝写入且原文件保持不变', () => {
  for (const original of ['{"schemaVersion":99,"runtime":"future"}', 'broken']) {
    const directory = fixture()
    const path = join(directory, 'desktop-data-format.json')
    writeFileSync(path, original)
    expect(() => ensureDesktopDataFormat(directory)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(original)
  }
})

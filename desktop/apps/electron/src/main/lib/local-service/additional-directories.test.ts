import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAdditionalDirectories } from './additional-directories'

test('显式目录以会话 cwd 解析，软链接重复项合并，不存在或普通文件明确失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'xcodes-add-dir-'))
  try {
    mkdirSync(join(root, 'attached'))
    symlinkSync(join(root, 'attached'), join(root, 'alias'))
    writeFileSync(join(root, 'file'), 'fixture')
    expect(resolveAdditionalDirectories(['attached', 'alias', join(root, 'attached')], root))
      .toEqual([realpathSync(join(root, 'attached'))])
    expect(resolveAdditionalDirectories(undefined, root)).toEqual([])
    expect(() => resolveAdditionalDirectories(['file'], root)).toThrow('附加目录不可用')
    expect(() => resolveAdditionalDirectories(['missing'], root)).toThrow('附加目录不可用')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

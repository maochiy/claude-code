import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyPackagedLocalRuntimeAfterSign } from './electron-builder-after-sign'

describe('afterSign 入口', () => {
  test('Given context 提供实际 Bundle 名 When 校验 Runtime Then 动态使用该名称', () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'proma-after-sign-context-'))
    try {
      expect(() =>
        verifyPackagedLocalRuntimeAfterSign({
          appOutDir,
          electronPlatformName: 'darwin',
          arch: 3,
          packager: {
            appInfo: {
              productFilename: 'context-name',
            },
          },
        }),
      ).toThrow(/context-name\.app/)
    } finally {
      rmSync(appOutDir, { recursive: true, force: true })
    }
  })
})

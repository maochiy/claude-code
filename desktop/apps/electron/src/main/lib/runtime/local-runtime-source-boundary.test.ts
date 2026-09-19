import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const electronRoot = join(import.meta.dir, '../../../..')

function productionFiles(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    if (
      !entry.isFile()
      || entry.name.includes('.test.')
      || (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx'))
    ) return []
    return [path]
  })
}

describe('Local CLI 正式执行边界', () => {
  test('Given 桌面生产源码 When 检查执行入口 Then 不再引用旧 Pi 引擎', () => {
    const forbiddenReferences = [
      '@earendil-works/',
      'frakio-pi-runtime-adapter',
      'pi-runtime-adapter',
      'pi-mcp-bridge',
      'pi-query-options',
      'pi-worker-compat',
      'resources/pi-runtime',
    ]
    const matches = productionFiles(join(electronRoot, 'src')).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return forbiddenReferences
        .filter((reference) => source.includes(reference))
        .map((reference) => `${path}: ${reference}`)
    })

    expect(matches).toEqual([])
  })

  test('Given 应用依赖与资源 When 检查分发边界 Then 只保留 Local CLI 产物', () => {
    const manifest = readFileSync(join(electronRoot, 'package.json'), 'utf8')
    const builder = readFileSync(join(electronRoot, 'electron-builder.yml'), 'utf8')

    expect(manifest).not.toContain('@earendil-works/')
    expect(builder).not.toContain('pi-runtime')
    expect(builder).not.toContain('pi-worker-compat')
    expect(existsSync(join(electronRoot, 'resources', 'pi-runtime'))).toBe(false)
    expect(existsSync(join(electronRoot, 'resources', 'pi-worker-compat.cjs'))).toBe(false)
    expect(builder).toContain('resources/local-runtime')
  })
})

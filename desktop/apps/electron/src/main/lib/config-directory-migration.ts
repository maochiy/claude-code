import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export type ConfigDirectoryMigrationStatus =
  | 'fresh'
  | 'migrated'
  | 'target-exists'

export interface ConfigDirectoryMigrationResult {
  directory: string
  status: ConfigDirectoryMigrationStatus
  failureCategory?: ConfigDirectoryMigrationFailureCategory
}

export type ConfigDirectoryMigrationFailureCategory =
  | 'invalid-target'
  | 'unsafe-legacy-root'
  | 'copy-failed'
  | 'publish-failed'

export interface ConfigDirectoryMigrationOptions {
  legacyDirectory: string
  targetDirectory: string
  copyDirectory?: (source: string, target: string) => void
}

type ConfigPathKind = 'missing' | 'directory' | 'symlink' | 'other'

function getPathKind(path: string): ConfigPathKind {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return 'symlink'
    if (stat.isDirectory()) return 'directory'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function assertMigrationSourceIsSafe(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    throw new Error('旧配置目录是符号链接，拒绝自动迁移')
  }
  if (!stat.isDirectory()) {
    throw new Error('旧配置路径不是目录，拒绝自动迁移')
  }
}

function copyDirectoryWithoutDereferencingSymlinks(source: string, target: string): void {
  cpSync(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
  })
}

/**
 * 准备 Xcode 配置目录。
 *
 * 旧目录只做字节级复制，不解析或改写 JSON/JSONL，因此历史中的旧绝对路径
 * 仍由保留的旧目录继续承载。复制先落到同一父目录下的隔离临时目录，完成后
 * 再原子 rename 发布；失败时停止启动并保留旧目录，不能退回旧目录继续写入。
 */
export function ensureMigratedConfigDirectory(
  options: ConfigDirectoryMigrationOptions,
): ConfigDirectoryMigrationResult {
  const { legacyDirectory, targetDirectory } = options
  const targetKind = getPathKind(targetDirectory)

  if (targetKind === 'directory') {
    return { directory: targetDirectory, status: 'target-exists' }
  }

  const legacyKind = getPathKind(legacyDirectory)

  if (targetKind !== 'missing') {
    throw new Error('配置目录迁移失败 [invalid-target]')
  }

  if (legacyKind === 'missing') {
    mkdirSync(targetDirectory, { recursive: true })
    return { directory: targetDirectory, status: 'fresh' }
  }

  let stagingRoot: string | undefined
  let failureCategory: ConfigDirectoryMigrationFailureCategory = 'unsafe-legacy-root'
  try {
    assertMigrationSourceIsSafe(legacyDirectory)
    stagingRoot = mkdtempSync(
      join(dirname(targetDirectory), `.${basename(targetDirectory)}-migration-`),
    )
    const stagedDirectory = join(stagingRoot, basename(targetDirectory))
    const copyDirectory = options.copyDirectory ?? copyDirectoryWithoutDereferencingSymlinks
    failureCategory = 'copy-failed'
    copyDirectory(legacyDirectory, stagedDirectory)

    // 复制期间可能有另一个实例先完成迁移；已有目标始终优先且绝不覆盖。
    const concurrentTargetKind = getPathKind(targetDirectory)
    if (concurrentTargetKind === 'directory') {
      return { directory: targetDirectory, status: 'target-exists' }
    }
    if (concurrentTargetKind !== 'missing') {
      failureCategory = 'invalid-target'
      throw new Error('迁移期间目标路径被占用')
    }

    failureCategory = 'publish-failed'
    renameSync(stagedDirectory, targetDirectory)
    return { directory: targetDirectory, status: 'migrated' }
  } catch {
    throw new Error(`配置目录迁移失败 [${failureCategory}]；旧数据未修改，请修复目标目录后重试`)
  } finally {
    if (stagingRoot) {
      rmSync(stagingRoot, { recursive: true, force: true })
    }
  }
}

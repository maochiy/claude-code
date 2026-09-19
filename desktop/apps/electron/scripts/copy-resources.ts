import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

// 构建产物重建，防止旧版 Pi 等已删除资源残留；源资源缺失时直接失败。
const appRoot = resolve(import.meta.dir, '..')
const output = resolve(appRoot, 'dist/resources')
rmSync(output, { recursive: true, force: true })
mkdirSync(resolve(appRoot, 'dist'), { recursive: true })
cpSync(resolve(appRoot, 'resources'), output, { recursive: true })

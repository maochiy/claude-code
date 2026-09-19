import { describe, expect, test } from 'bun:test'
import {
  PROMA_DEFAULT_PERMISSION_MODE,
  PROMA_PERMISSION_MODES,
  migratePermissionMode,
} from './agent'

describe('Agent 权限模式迁移', () => {
  test('Given Runtime 六种原生模式 When 读取持久配置 Then 全部原样保留', () => {
    expect(PROMA_PERMISSION_MODES.map(migratePermissionMode)).toEqual([
      'default',
      'acceptEdits',
      'dontAsk',
      'bypassPermissions',
      'auto',
      'plan',
    ])
  })

  test('Given 未知旧值 When 读取持久配置 Then 回退到手动审批', () => {
    expect(PROMA_DEFAULT_PERMISSION_MODE).toBe('default')
    expect(migratePermissionMode('legacy-unknown')).toBe('default')
  })
})

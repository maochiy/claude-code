import { describe, expect, test } from 'bun:test'
import {
  EXECUTABLE_RUNTIME_ID,
  isExecutableRuntimeId,
  normalizeExecutableRuntimeId,
} from './executable-runtime-policy'

describe('Local CLI 执行策略', () => {
  test('Given 历史 RuntimeId When 进入执行边界 Then 全部迁移为 Local CLI', () => {
    expect(['pi', 'hermes', 'codex', 'claude', undefined].map(normalizeExecutableRuntimeId))
      .toEqual(['local-cli', 'local-cli', 'local-cli', 'local-cli', 'local-cli'])
  })

  test('Given Runtime 注册标识 When 判断是否可执行 Then 仅 Local CLI 可执行', () => {
    expect(EXECUTABLE_RUNTIME_ID).toBe('local-cli')
    expect(isExecutableRuntimeId('local-cli')).toBe(true)
    expect(isExecutableRuntimeId('pi')).toBe(false)
    expect(isExecutableRuntimeId('hermes')).toBe(false)
    expect(isExecutableRuntimeId('codex')).toBe(false)
    expect(isExecutableRuntimeId('claude')).toBe(false)
  })
})

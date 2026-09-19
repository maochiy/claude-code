import { describe, expect, test } from 'bun:test'
import { availableBuiltinTools, normalizeToolPolicy, toolPolicyAllows } from './tool-policy'

describe('注册 Agent 工具可用范围', () => {
  test('none 是空工具范围；缺省不限制', () => {
    expect(availableBuiltinTools({ allowedTools: [] })).toEqual([])
    expect(toolPolicyAllows({ allowedTools: [] }, 'Read')).toBe(false)
    expect(availableBuiltinTools(undefined)).toBeUndefined()
    expect(toolPolicyAllows(undefined, 'Bash')).toBe(true)
  })
  test('旧小写名称规范化，MCP 不进入内置工具目录', () => {
    const policy = { allowedTools: ['read', 'mcp__fixture__read'] }
    expect(availableBuiltinTools(policy)).toEqual(['Read'])
    expect(toolPolicyAllows(policy, 'Read')).toBe(true)
    expect(toolPolicyAllows(policy, 'Bash')).toBe(false)
    expect(toolPolicyAllows(policy, 'mcp__other__read')).toBe(false)
  })
  test('精确和通配匹配均保持 deny 优先', () => {
    const policy = { allowedTools: ['mcp__fixture__*'], disallowedTools: ['mcp__fixture__write'] }
    expect(toolPolicyAllows(policy, 'mcp__fixture__read')).toBe(true)
    expect(toolPolicyAllows(policy, 'mcp__fixture__write')).toBe(false)
    expect(toolPolicyAllows(policy, 'mcp__other__read')).toBe(false)
    expect(toolPolicyAllows({ allowedTools: ['*'], disallowedTools: ['Bash'] }, 'Bash')).toBe(false)
  })
  test('命令规则不能被误解为无条件允许一个工具', () => {
    expect(() => normalizeToolPolicy({ allowedTools: ['Bash(rm *)'] })).toThrow()
  })
})

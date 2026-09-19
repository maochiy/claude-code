import { describe, expect, test } from 'bun:test'
import { buildRuntimeUserClockLine, buildRuntimeTaskSystemPrompt, buildSystemPrompt } from './agent-prompt-builder'

describe('Agent 系统提示词', () => {
  test('Given 原生 CLI 与 MCP 目录 When 构建提示词 Then 直接使用真实能力而非旧 Pi 网关', () => {
    const prompt = buildSystemPrompt({ sessionId: 'session-id', permissionMode: 'default', collaborationAvailable: true })
    expect(prompt).toContain('mcp__web_search__WebSearch')
    expect(prompt).toContain('mcp__browser__browser_get_state')
    expect(prompt).toContain('CLI 原生 Agent')
    expect(prompt).toContain('elements.ref')
    expect(prompt).not.toContain('proma_mcp_discover')
    expect(prompt).not.toContain('proma_mcp_call')
    expect(prompt).not.toContain('禁止使用 Runtime 原生的 WebSearch')
    expect(prompt).not.toContain('不存在的 Runtime 原生 Subagent')
  })

  test('Given 浏览器任务需要用户介入 When 主会话或兼容子任务构建提示词 Then 复用任务并等待真实答复', () => {
    for (const prompt of [
      buildSystemPrompt({ sessionId: 'session-id', permissionMode: 'default' }),
      buildRuntimeTaskSystemPrompt('codex', 'complex_reasoning'),
    ]) {
      expect(prompt).toContain('browser_list_tasks')
      expect(prompt).toContain('禁止通过更换 taskId')
      expect(prompt).toContain('AskUserQuestion 请求并等待真实答复')
      expect(prompt).toContain('不要为了保留页面而虚构等待')
      expect(prompt).not.toContain('proma_mcp_call')
    }
  })

  test('Given Plan 模式 When 计划准备完成 Then 发起原生审批而非先等待批准造成死锁', () => {
    const prompt = buildSystemPrompt({ sessionId: 'session-id', permissionMode: 'plan' })
    expect(prompt).toContain('通过 ExitPlanMode 请求用户审批及目标模式')
    expect(prompt).toContain('允许的计划文档')
    expect(prompt).not.toContain('等待用户批准，再通过 ExitPlanMode')
  })

  test('Given 历史任务标识仍为其它 Runtime When 构建子 Agent 提示词 Then 角色始终声明为 Local CLI', () => {
    for (const runtimeId of ['hermes', 'codex', 'claude'] as const) {
      const prompt = buildRuntimeTaskSystemPrompt(runtimeId, 'legacy_task')
      expect(prompt).toContain('当前内核：Local CLI')
      expect(prompt).toContain('CLI 子 Agent')
      expect(prompt).not.toContain('Hermes 调度内核')
      expect(prompt).not.toContain('Codex Harness')
      expect(prompt).not.toContain('Claude Code Harness')
    }
  })

  test('Given Local CLI 用户消息需要时刻 When 生成时钟行 Then 带时分且不进入 system 附录格式', () => {
    const line = buildRuntimeUserClockLine(new Date('2026-08-24T03:11:00+08:00'))
    expect(line).toContain('当前时间:')
    expect(line).toMatch(/\d{2}:\d{2}/)
  })
})

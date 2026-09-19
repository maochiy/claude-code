import { describe, expect, test } from 'bun:test'
import {
  buildAgentSlashCommands,
  buildAgentSlashSuggestions,
  executeAgentSlashUiAction,
  isAgentClearCommand,
  resolveAgentSlashSelection,
} from './agent-slash-commands'

const skills = [
  { id: 'code-review', name: 'Code Review', description: '审查代码' },
  { id: 'pdf', name: 'PDF Reader', description: '读取 PDF' },
]
const uiActions = ['clear-session', 'enable-plan-mode', 'open-model-selector'] as const
const runtimeCommands = [
  { name: 'clear', description: 'Clear context', argumentHint: '' },
  { name: 'compact', description: 'Compact context', argumentHint: '[focus]' },
  { name: 'plan', description: 'Enter plan mode', argumentHint: '' },
  { name: 'model', description: 'Select model', argumentHint: '' },
]

describe('Agent slash 候选', () => {
  test('Given 空查询 When 打开 slash 菜单 Then 展示真实命令并合并可调用 Skills', () => {
    const suggestions = buildAgentSlashSuggestions(skills, '', uiActions, runtimeCommands)

    expect(buildAgentSlashCommands(runtimeCommands, uiActions).map((command) => command.value)).toEqual([
      '/clear',
      '/compact',
      '/plan',
      '/model',
    ])
    expect(suggestions.map((item) => item.kind)).toEqual([
      'command',
      'command',
      'command',
      'command',
      'skill',
      'skill',
    ])
  })

  test('Given 输入命令片段 When 过滤 Then 只保留匹配的真实命令', () => {
    const suggestions = buildAgentSlashSuggestions(skills, 'comp', [], runtimeCommands)

    expect(suggestions).toEqual([
      {
        kind: 'command',
        command: expect.objectContaining({ value: '/compact' }),
      },
    ])
  })

  test('Given CLI 目录与工作区都包含同一 Skill When 合并候选 Then 只保留 CLI 权威命令', () => {
    const suggestions = buildAgentSlashSuggestions(
      [{ id: 'computer-use', name: 'computer-use', description: '工作区 Skill' }],
      'comp',
      [],
      [{ name: 'computer-use', description: '浏览器操作 (project)', argumentHint: '' }],
    )

    expect(suggestions).toEqual([
      {
        kind: 'command',
        command: expect.objectContaining({
          value: '/computer-use',
          description: '浏览器操作 (project)',
        }),
      },
    ])
  })

  test('Given 同名 Skill 来自多个作用域 When 合并候选 Then 保留上游优先级最高的一项', () => {
    const projectSkill = {
      id: 'project:computer-use',
      name: 'computer-use',
      description: '项目级 Skill',
    }
    const suggestions = buildAgentSlashSuggestions([
      projectSkill,
      { id: 'user:computer-use', name: 'computer-use', description: '用户级 Skill' },
      { id: 'pdf', name: 'PDF Reader', description: '不同 Skill' },
    ], '')

    expect(suggestions).toEqual([
      { kind: 'skill', skill: projectSkill },
      { kind: 'skill', skill: expect.objectContaining({ id: 'pdf' }) },
    ])
  })

  test('Given CLI 名称带来源标记 When 合并同名 Skill Then 仍只保留原始 CLI 候选', () => {
    const suggestions = buildAgentSlashSuggestions(
      [{ id: 'computer-use', name: 'computer-use' }],
      'comp',
      [],
      [{ name: 'computer-use (project)', description: '浏览器操作', argumentHint: '' }],
    )

    expect(suggestions).toEqual([
      {
        kind: 'command',
        command: expect.objectContaining({ value: '/computer-use (project)' }),
      },
    ])
  })

  test('Given 命令与 Skill 仅部分同名 When 合并候选 Then 不误删不同调用入口', () => {
    const suggestions = buildAgentSlashSuggestions(
      [{ id: 'computer-use', name: 'computer-use' }],
      '',
      [],
      [{ name: 'computer', description: '查看计算机信息', argumentHint: '' }],
    )

    expect(suggestions.map((item) => item.kind === 'command'
      ? item.command.value
      : item.skill.id)).toEqual(['/computer', 'computer-use'])
  })

  test('Given 输入 Skill 名称 When 过滤 Then 保留匹配 Skill 且不混入不匹配命令', () => {
    const suggestions = buildAgentSlashSuggestions(skills, 'review')

    expect(suggestions).toEqual([
      {
        kind: 'skill',
        skill: skills[0]!,
      },
    ])
  })

  test('Given 选中命令 When 应用选择 Then 只返回待插入文本而不触发发送动作', () => {
    const [suggestion] = buildAgentSlashSuggestions(skills, 'compact', [], runtimeCommands)

    expect(suggestion).toBeDefined()
    expect(resolveAgentSlashSelection(suggestion!)).toEqual({
      type: 'text',
      text: '/compact ',
    })
  })

  test('Given 没有 UI 命令处理器 When 构建候选 Then 原生命令仍作为待发送文本可用', () => {
    const suggestions = buildAgentSlashSuggestions(skills, '', [], runtimeCommands)

    expect(suggestions.some((item) => item.kind === 'command' && item.command.value === '/plan')).toBe(true)
    expect(suggestions.some((item) => item.kind === 'command' && item.command.value === '/model')).toBe(true)
    expect(suggestions.some((item) => item.kind === 'command' && item.command.value === '/compact')).toBe(true)
  })

  test.each([
    ['clear', 'clear-session'],
    ['plan', 'enable-plan-mode'],
    ['model', 'open-model-selector'],
  ] as const)('Given 选中 /%s When 解析命令 Then 返回已有 UI 动作且不生成待发送文本', (query, action) => {
    const [suggestion] = buildAgentSlashSuggestions(skills, query, uiActions, runtimeCommands)

    expect(suggestion).toBeDefined()
    expect(resolveAgentSlashSelection(suggestion!)).toEqual({ type: 'action', action })
  })

  test('Given CLI initialize 只返回新增命令 When 构建候选 Then 不混入桌面硬编码命令', () => {
    const suggestions = buildAgentSlashSuggestions(skills, '', uiActions, [
      { name: 'doctor', description: 'Diagnose setup', argumentHint: '' },
    ])

    expect(suggestions.filter((item) => item.kind === 'command')).toEqual([
      { kind: 'command', command: expect.objectContaining({ value: '/doctor' }) },
    ])
    expect(suggestions.some((item) => item.kind === 'command' && item.command.value === '/compact')).toBe(false)
  })

  test('Given /plan UI 动作 When 执行 Then 只启用计划模式且不打开模型选择', () => {
    const calls: string[] = []

    executeAgentSlashUiAction('enable-plan-mode', {
      clearSession: () => calls.push('clear'),
      enablePlanMode: () => calls.push('plan'),
      openModelSelector: () => calls.push('model'),
    })

    expect(calls).toEqual(['plan'])
  })

  test('Given /model UI 动作 When 执行 Then 只打开模型选择', () => {
    const calls: string[] = []

    executeAgentSlashUiAction('open-model-selector', {
      clearSession: () => calls.push('clear'),
      enablePlanMode: () => calls.push('plan'),
      openModelSelector: () => calls.push('model'),
    })

    expect(calls).toEqual(['model'])
  })

  test('Given /clear UI 动作 When 执行 Then 只清空会话且不触发其他 UI', () => {
    const calls: string[] = []

    executeAgentSlashUiAction('clear-session', {
      clearSession: () => calls.push('clear'),
      enablePlanMode: () => calls.push('plan'),
      openModelSelector: () => calls.push('model'),
    })

    expect(calls).toEqual(['clear'])
  })

  test.each(['/clear', '/CLEAR', '/reset ', '/new\n'])(
    'Given 输入 %s When 识别清空命令 Then 不发送给模型',
    (text) => expect(isAgentClearCommand(text)).toBe(true),
  )

  test.each(['/clear now', ' /clear', '/new context', 'clear'])(
    'Given 输入 %s When 识别清空命令 Then 保留普通发送语义',
    (text) => expect(isAgentClearCommand(text)).toBe(false),
  )
})

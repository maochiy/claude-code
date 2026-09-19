import { describe, expect, test } from 'bun:test'
import { extractPlanDocument, getPlanDocumentStage } from './plan-document'

function user(text: string): Record<string, unknown> {
  return {
    type: 'user',
    uuid: `user:${text}`,
    parent_tool_use_id: null,
    message: { content: [{ type: 'text', text }] },
  }
}

function assistant(
  uuid: string,
  content: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { id: `model:${uuid}`, content },
    ...extra,
  }
}

describe('计划正文提取', () => {
  test('Given 历史包含多种结构化计划 When 提取 Then 返回最新一轮且支持四种别名', () => {
    const aliases = ['plan', 'proposed_plan', 'plan_proposal', 'proposed-plan']
    for (const alias of aliases) {
      expect(extractPlanDocument([
        user('旧任务'),
        assistant('old', [{ type: 'plan', content: '旧计划' }]),
        user('新任务'),
        assistant('latest', [{ type: alias, text: `新计划-${alias}` }]),
      ])).toEqual({
        id: 'model:latest:plan:0',
        content: `新计划-${alias}`,
      })
    }
  })

  test('Given 结构化计划流式增长 When 重提取 Then 内容更新而 ID 保持稳定', () => {
    const partial = assistant('partial-uuid', [{ type: 'proposed_plan', content: '第一步' }], { _partial: true })
    const final = assistant('final-uuid', [{ type: 'proposed_plan', content: '第一步\n第二步' }])
    ;(partial.message as Record<string, unknown>).id = 'shared-model-message'
    ;(final.message as Record<string, unknown>).id = 'shared-model-message'
    const before = extractPlanDocument([
      user('列计划'),
      partial,
    ])
    const after = extractPlanDocument([
      user('列计划'),
      final,
    ])

    expect(before?.id).toBe(after?.id)
    expect(after?.content).toBe('第一步\n第二步')
  })

  test('Given ExitPlanMode 显式携带 plan When 提取 Then 优先使用工具输入正文', () => {
    expect(extractPlanDocument([
      user('列计划'),
      assistant('exit', [
        { type: 'text', text: '预览摘要' },
        { type: 'tool_use', id: 'exit-1', name: 'ExitPlanMode', input: { plan: '# 完整计划' } },
      ]),
    ])).toEqual({ id: 'exit-plan:exit-1', content: '# 完整计划' })
  })

  test('Given Runtime 明确提供计划源路径 When 提取 Then 保留真实路径供工具栏定位', () => {
    expect(extractPlanDocument([
      user('列计划'),
      assistant('file-plan', [{
        type: 'proposed_plan',
        content: '# 文件计划',
        source_path: '/repo/.plans/feature.md',
      }]),
    ])).toEqual({
      id: 'model:file-plan:plan:0',
      content: '# 文件计划',
      sourcePath: '/repo/.plans/feature.md',
    })

    expect(extractPlanDocument([
      user('列计划'),
      assistant('memory-plan', [{ type: 'plan', content: '# 内存计划' }]),
    ])?.sourcePath).toBeUndefined()
  })

  test('Given ExitPlanMode 前有连续正文 When 提取 Then 合并正文且不包含更早过程内容', () => {
    expect(extractPlanDocument([
      user('列计划'),
      assistant('exit', [
        { type: 'text', text: '过程说明' },
        { type: 'tool_use', id: 'read-1', name: 'Read', input: {} },
        { type: 'text', text: '# 计划' },
        { type: 'text', text: '1. 修改界面' },
        { type: 'tool_use', id: 'exit-2', name: 'ExitPlanMode', input: {} },
      ]),
    ])).toEqual({
      id: 'exit-plan:exit-2',
      content: '# 计划\n\n1. 修改界面',
    })
  })

  test('Given 子 Agent 和用户正文看起来像计划 When 提取 Then 不作为计划来源', () => {
    expect(extractPlanDocument([
      user('# 用户写的计划'),
      {
        ...assistant('child', [{ type: 'plan', content: '子 Agent 计划' }]),
        parent_tool_use_id: 'parent-tool',
      },
    ])).toBeUndefined()
  })

  test('Given 新一轮真实用户只含字符串或图片 When 查找 ExitPlanMode 前正文 Then 不跨轮复用旧正文', () => {
    for (const content of ['新问题', [{ type: 'image', source: { data: 'preview' } }]]) {
      expect(extractPlanDocument([
        user('旧任务'),
        assistant('old-text', [{ type: 'text', text: '# 旧计划' }]),
        { type: 'user', uuid: 'new-input', parent_tool_use_id: null, message: { content } },
        assistant('new-exit', [
          { type: 'tool_use', id: 'new-exit-tool', name: 'ExitPlanMode', input: {} },
        ]),
      ])).toBeUndefined()
    }
  })

  test('Given 携带错误的 assistant 含结构化计划 When 提取 Then 忽略错误消息', () => {
    expect(extractPlanDocument([
      user('列计划'),
      assistant('failed-plan', [{ type: 'plan', content: '不完整计划' }], {
        error: { message: 'runtime failed' },
      }),
    ])).toBeUndefined()
  })

  test('Given 计划模式仍在工具前过程阶段 When 提取 Then 不提前展示过程正文', () => {
    expect(extractPlanDocument([
      user('列计划'),
      assistant('process', [{ type: 'text', text: '我先检查文件。' }], {
        _partial: true,
        _promaActivityPhase: 'text',
      }),
      assistant('tool', [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }]),
    ], { planMode: true })).toBeUndefined()
  })

  test('Given 计划模式本轮成功结束 When 提取 Then 只取最后一次工具后的最终正文', () => {
    expect(extractPlanDocument([
      user('列计划'),
      assistant('before-tool', [{ type: 'text', text: '我先检查。' }]),
      assistant('tool', [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }]),
      assistant('final', [
        { type: 'text', text: '# 完整计划' },
        { type: 'text', text: '1. 实施改动' },
      ]),
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ], { planMode: true })).toEqual({
      id: 'model:final:plan-final:0',
      content: '# 完整计划\n\n1. 实施改动',
    })
  })

  test('Given Pi 明确标记最终 idle 阶段 When 尚无 result Then 接受非 partial 最终正文', () => {
    expect(extractPlanDocument([
      user('列计划'),
      assistant('final', [{ type: 'text', text: '# 可审批计划' }], {
        _promaActivityPhase: 'idle',
      }),
    ], { planMode: true })).toEqual({
      id: 'model:final:plan-final:0',
      content: '# 可审批计划',
    })
  })

  test('Given 历史回复持久化了计划模式标记 When 重新加载且未传实时选项 Then 恢复最终计划', () => {
    expect(extractPlanDocument([
      user('列计划'),
      assistant('historical-plan', [{ type: 'text', text: '# 历史计划' }], {
        _promaPlanMode: true,
      }),
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ])).toEqual({
      id: 'model:historical-plan:plan-final:0',
      content: '# 历史计划',
    })
  })

  test('Given 历史普通回复没有计划标记 When 重新加载 Then 不把它误判成计划', () => {
    expect(extractPlanDocument([
      user('解释代码'),
      assistant('ordinary-answer', [{ type: 'text', text: '这是普通回答。' }]),
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ])).toBeUndefined()
  })

  test('Given 同轮计划过程后已切换执行模式 When 执行成功 Then 不把执行结果或计划过程误判成计划', () => {
    expect(extractPlanDocument([
      user('先列计划再执行'),
      assistant('plan-process', [{ type: 'text', text: '我正在整理计划。' }], {
        _promaPlanMode: true,
        _promaActivityPhase: 'text',
      }),
      assistant('execution', [{ type: 'text', text: '实现已经完成。' }], {
        _promaPlanMode: false,
        _promaActivityPhase: 'idle',
      }),
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ])).toBeUndefined()
  })

  test('Given idle 正文之后收到失败或停止 result When 提取 Then 不把半成品当成成功计划', () => {
    for (const subtype of ['error_during_execution', 'interrupted']) {
      expect(extractPlanDocument([
        user('列计划'),
        assistant('failed-final', [{ type: 'text', text: '# 半成品计划' }], {
          _promaPlanMode: true,
          _promaActivityPhase: 'idle',
        }),
        { type: 'result', subtype, usage: { input_tokens: 1, output_tokens: 1 } },
      ])).toBeUndefined()
    }
  })

  test('Given 计划模式已成功但最新消息是 partial When 提取 Then 不把未完成正文当计划', () => {
    expect(extractPlanDocument([
      user('列计划'),
      assistant('partial', [{ type: 'text', text: '# 未完成计划' }], { _partial: true }),
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ], { planMode: true })).toBeUndefined()
  })
})

describe('计划文档历史阶段', () => {
  const document = { id: 'exit-plan:exit-1', content: '# 计划' }

  test('Given 只有计划正文 When 缺少 ExitPlanMode 证据 Then 显示为计划文档', () => {
    expect(getPlanDocumentStage([], { id: 'model:plan-final:0', content: '# 计划' })).toBe('document')
  })

  test('Given ExitPlanMode 已发起但未处理 When 投影阶段 Then 显示为提出计划', () => {
    expect(getPlanDocumentStage([], document)).toBe('proposed')
  })

  test('Given 同一个 ExitPlanMode 有明确终态 When 投影阶段 Then 区分批准、修改与拒绝', () => {
    const settlement = (outcome: string): Record<string, unknown> => ({
      type: 'system',
      subtype: 'interaction_settled',
      settlement: { kind: 'exit_plan', toolUseId: 'exit-1', outcome },
    })

    expect(getPlanDocumentStage([settlement('approved')], document)).toBe('approved')
    expect(getPlanDocumentStage([settlement('feedback')], document)).toBe('changes_requested')
    expect(getPlanDocumentStage([settlement('denied')], document)).toBe('rejected')
  })

  test('Given 结算属于另一个工具 When 投影阶段 Then 不误改当前计划阶段', () => {
    expect(getPlanDocumentStage([{
      type: 'system',
      subtype: 'interaction_settled',
      settlement: { kind: 'exit_plan', toolUseId: 'exit-other', outcome: 'approved' },
    }], document)).toBe('proposed')
  })
})

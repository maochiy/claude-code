import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import { runGitCommitMessageQuery, type GitCommitMessageRuntime } from './git-commit-message'
import type { LocalCliAgentQueryOptions } from './query-options'

class FakeRuntime implements GitCommitMessageRuntime {
  readonly inputs: LocalCliAgentQueryOptions[] = []
  readonly closed: string[] = []

  constructor(private readonly messages: SDKMessage[]) {}

  async *query(input: LocalCliAgentQueryOptions): AsyncGenerator<SDKMessage> {
    this.inputs.push(input)
    for (const message of this.messages) yield message
  }

  async closeSession(sessionId: string): Promise<void> {
    this.closed.push(sessionId)
  }
}

function options(): LocalCliAgentQueryOptions {
  return {
    sessionId: '0d8b90bc-a992-4e90-bd32-755f96c70fb4',
    prompt: '生成提交信息',
    cwd: '/tmp/proma-git-commit-message',
    model: 'model-a',
  }
}

describe('Git 提交信息 Local CLI 执行', () => {
  test('Given CLI 返回预览帧与终态 When 生成提交信息 Then 仅采用终态正文并关闭一次性会话', async () => {
    const runtime = new FakeRuntime([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'feat: partial' }] },
        parent_tool_use_id: null,
        _partial: true,
      } as unknown as SDKMessage,
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'feat: use local cli' }] },
        parent_tool_use_id: null,
      },
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    ])

    await expect(runGitCommitMessageQuery(runtime, options())).resolves.toBe('feat: use local cli')
    expect(runtime.inputs).toHaveLength(1)
    expect(runtime.closed).toEqual(['0d8b90bc-a992-4e90-bd32-755f96c70fb4'])
  })

  test('Given CLI 返回失败终态 When 生成提交信息 Then 返回空结果供调用方回退且仍关闭会话', async () => {
    const runtime = new FakeRuntime([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '不应采用' }] },
        parent_tool_use_id: null,
      },
      { type: 'result', subtype: 'error', usage: { input_tokens: 1, output_tokens: 1 } },
    ])

    await expect(runGitCommitMessageQuery(runtime, options())).resolves.toBeNull()
    expect(runtime.closed).toEqual(['0d8b90bc-a992-4e90-bd32-755f96c70fb4'])
  })
})

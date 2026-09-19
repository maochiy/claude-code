import type { SDKMessage } from '@proma/shared'
import { extractFinalAssistantText } from '../bridge-agent-message-utils'
import type { LocalCliAgentQueryOptions } from './query-options'

export interface GitCommitMessageRuntime {
  query(input: LocalCliAgentQueryOptions): AsyncIterable<SDKMessage>
  closeSession(sessionId: string): Promise<void>
}

/** 使用一次性原生 CLI Session 生成提交信息，结束后只关闭本会话。 */
export async function runGitCommitMessageQuery(
  runtime: GitCommitMessageRuntime,
  options: LocalCliAgentQueryOptions,
): Promise<string | null> {
  let answer = ''
  let succeeded = false
  try {
    for await (const message of runtime.query(options)) {
      const text = extractFinalAssistantText(message)
      if (text.trim()) answer = text
      if (message.type === 'result') succeeded = message.subtype === 'success'
    }
    return succeeded && answer.trim() ? answer.trim() : null
  } finally {
    await runtime.closeSession(options.sessionId).catch(() => {})
  }
}

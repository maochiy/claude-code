import { describe, expect, test } from 'bun:test'
import { redactRuntimeSecrets } from './environment.js'

describe('Desktop Runtime 日志脱敏', () => {
  test('Given ChatGPT OAuth 环境变量 When 脱敏 Then 不保留 access 和 refresh token', () => {
    const output = redactRuntimeSecrets(
      'OPENAI_CHATGPT_ACCESS_TOKEN=access-secret ' +
        '"OPENAI_CHATGPT_REFRESH_TOKEN":"refresh-secret"',
    )

    expect(output).not.toContain('access-secret')
    expect(output).not.toContain('refresh-secret')
    expect(output).toContain('OPENAI_CHATGPT_ACCESS_TOKEN=[REDACTED]')
    expect(output).toContain('"OPENAI_CHATGPT_REFRESH_TOKEN":"[REDACTED]"')
  })
})

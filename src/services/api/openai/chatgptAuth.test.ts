import { afterEach, describe, expect, test } from 'bun:test'
import { getValidChatGPTAuth } from './chatgptAuth.js'

const ORIGINAL_ENV = { ...process.env }
const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in ORIGINAL_ENV)) delete process.env[name]
  }
  Object.assign(process.env, ORIGINAL_ENV)
  globalThis.fetch = ORIGINAL_FETCH
})

describe('Desktop 注入 ChatGPT 凭证', () => {
  test('Given 未过期的注入凭证 When 获取认证 Then 不读取登录流程或请求网络', async () => {
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'desktop-access'
    process.env.OPENAI_CHATGPT_REFRESH_TOKEN = 'desktop-refresh'
    process.env.OPENAI_CHATGPT_EXPIRES_AT = String(Date.now() + 60 * 60 * 1000)
    process.env.OPENAI_CHATGPT_ACCOUNT_ID = 'account-1'
    globalThis.fetch = (() => {
      throw new Error('不应请求网络')
    }) as unknown as typeof fetch

    await expect(getValidChatGPTAuth()).resolves.toEqual({
      accessToken: 'desktop-access',
      accountId: 'account-1',
    })
  })
})

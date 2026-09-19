import { describe, expect, mock, test } from 'bun:test'
import type {
  AgentProviderAdapter,
  AgentQueryInput,
  RuntimeModelRoute,
  SDKMessage,
} from '@proma/shared'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: (): string => process.cwd(),
    getPath: (): string => '/tmp',
  },
  clipboard: {},
  dialog: {},
  safeStorage: {
    isEncryptionAvailable: (): boolean => false,
  },
  shell: {},
}))

const { RuntimeAdapterRouter } = await import('./runtime-adapters')

class CapturingLocalCliAdapter implements AgentProviderAdapter {
  input: AgentQueryInput | null = null

  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    this.input = input
  }

  async abort(): Promise<void> {}

  dispose(): void {}
}

function legacyRoute(): RuntimeModelRoute {
  return {
    routeRevision: 'revision',
    runtimeId: 'claude',
    channelId: 'channel',
    modelId: 'model',
    provider: 'openai',
    baseUrl: 'https://example.test/v1',
    apiMode: 'openai_chat_completions',
    credentialRevision: 'credential',
    capabilities: {},
    source: 'proma-channel',
  }
}

describe('RuntimeAdapterRouter Local CLI 执行边界', () => {
  test('Given 查询仍携带旧 RuntimeId When 进入 Router Then 只向 Local CLI 传递规范化输入', async () => {
    const localCli = new CapturingLocalCliAdapter()
    const router = new RuntimeAdapterRouter(localCli)
    for await (const _message of router.query({
      sessionId: 'session',
      runtimeId: 'claude',
      prompt: 'test',
      modelRoute: legacyRoute(),
    })) {
      // 捕获适配器不产生消息。
    }
    expect(localCli.input?.runtimeId).toBe('local-cli')
    expect(localCli.input?.modelRoute?.runtimeId).toBe('local-cli')
  })
})

import { app } from 'electron'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { configureAppBranding } from '../../src/main/lib/app-branding'

interface FixtureSeedResult {
  channelId?: string
  modelId?: string
  providerChannelSeeded: boolean
  workspaceId: string
  projectPath: string
  profileName: string
}

function requiredAbsolutePath(name: string): string {
  const value = process.env[name]?.trim()
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} 必须是非空绝对路径`)
  }
  return value
}

function requiredLoopbackUrl(): string {
  const value = process.env.XCODES_NATIVE_UI_BASE_URL?.trim()
  if (!value) throw new Error('缺少 XCODES_NATIVE_UI_BASE_URL')
  const url = new URL(value)
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
    throw new Error('UI fixture 渠道只允许 http loopback 地址')
  }
  return url.origin
}

function shouldSeedProviderChannel(): boolean {
  const value = process.env.XCODES_NATIVE_UI_SEED_PROVIDER_CHANNEL?.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('XCODES_NATIVE_UI_SEED_PROVIDER_CHANNEL 必须为 true 或 false')
}

const dataRoot = requiredAbsolutePath('XCODES_DATA_ROOT')
requiredAbsolutePath('HOME')
requiredAbsolutePath('CLAUDE_CONFIG_DIR')
const projectPath = realpathSync.native(requiredAbsolutePath('XCODES_NATIVE_UI_PROJECT_PATH'))
const baseUrl = requiredLoopbackUrl()
const seedProviderChannel = shouldSeedProviderChannel()

configureAppBranding(app, dataRoot)

async function seed(): Promise<FixtureSeedResult> {
  const [
    { createAgentWorkspace },
    { updateSettings },
    { updateUserProfile },
  ] = await Promise.all([
    import('../../src/main/lib/agent-workspace-manager'),
    import('../../src/main/lib/settings-service'),
    import('../../src/main/lib/user-profile-service'),
  ])

  const workspace = createAgentWorkspace(projectPath)
  const profileName = '隔离验收 · 非真实账号'
  updateUserProfile({
    userName: profileName,
    avatar: '🧪',
  })

  let channelId: string | undefined
  let modelId: string | undefined
  if (seedProviderChannel) {
    // 仅 dev→dev 模式进入此分支，避免由开发 Electron 为正式包生成 safeStorage 密文。
    const { createChannel, listChannels } = await import('../../src/main/lib/channel-manager')
    if (listChannels().length > 0) {
      throw new Error('隔离数据目录在 seed 前已存在模型渠道，拒绝继续')
    }
    modelId = 'claude-native-interactions-fixture'
    const channel = createChannel({
      name: '隔离 Fake Anthropic',
      provider: 'anthropic-compatible',
      baseUrl,
      apiKey: 'fixture-api-key-not-valid-outside-loopback',
      models: [{
        id: modelId,
        name: 'Fixture Claude',
        contextWindow: 200_000,
        enabled: true,
        source: 'manual',
      }],
      defaultModelId: modelId,
      enabled: true,
    })
    channelId = channel.id

    const seededChannels = listChannels()
    if (seededChannels.length !== 1 || seededChannels[0]?.baseUrl !== baseUrl) {
      throw new Error('UI fixture 必须且只能包含一个 loopback Fake Provider 渠道')
    }
  }

  updateSettings({
    onboardingCompleted: true,
    environmentCheckSkipped: true,
    interfaceLanguage: 'zh',
    ...(channelId && modelId
      ? {
          agentChannelId: channelId,
          agentChannelIds: [channelId],
          agentModelId: modelId,
        }
      : {}),
    agentWorkspaceId: workspace.id,
    agentThinking: { type: 'disabled' },
  })

  return {
    channelId,
    modelId,
    providerChannelSeeded: seedProviderChannel,
    workspaceId: workspace.id,
    projectPath,
    profileName,
  }
}

app.whenReady()
  .then(seed)
  .then((result) => {
    console.log(`NATIVE_UI_SEED_RESULT=${JSON.stringify(result)}`)
    app.exit(0)
  })
  .catch((error: unknown) => {
    console.error('[UI fixture] 隔离数据 seed 失败:', error instanceof Error ? error.message : String(error))
    app.exit(1)
  })

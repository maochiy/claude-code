import { describe, expect, test } from 'bun:test'
import {
  createExpectedEvidence,
  createFixtureExecutionPlan,
  createIsolatedChildEnvironment,
  createProviderChannelSetup,
  createScenarioPrompts,
  createSeedProcessEnvironment,
  parsePrepareOptions,
} from './prepare-native-ui-fixture'

const paths = {
  home: '/tmp/fixture/home',
  dataRoot: '/tmp/fixture/data',
  claudeConfigDir: '/tmp/fixture/claude',
  configHome: '/tmp/fixture/config',
  cacheHome: '/tmp/fixture/cache',
}

describe('原生 UI fixture 隔离准备', () => {
  test('Given 主进程含真实 Provider 凭据 When 构建子进程环境 Then 只保留平台变量与隔离目录', () => {
    const environment = createIsolatedChildEnvironment({
      PATH: '/usr/bin',
      LANG: 'zh_CN.UTF-8',
      HOME: '/Users/real-user',
      OPENAI_API_KEY: 'real-openai-secret',
      ANTHROPIC_API_KEY: 'real-anthropic-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'real-claude-oauth-token',
      GITHUB_TOKEN: 'real-github-token',
      CLAUDE_CONFIG_DIR: '/Users/real-user/.claude',
      AWS_SECRET_ACCESS_KEY: 'real-aws-secret',
    }, paths)

    expect(environment.PATH).toBe('/usr/bin')
    expect(environment.HOME).toBe(paths.home)
    expect(environment.XCODES_DATA_ROOT).toBe(paths.dataRoot)
    expect(environment.CLAUDE_CONFIG_DIR).toBe(paths.claudeConfigDir)
    expect(environment.OPENAI_API_KEY).toBeUndefined()
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined()
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(environment.GITHUB_TOKEN).toBeUndefined()
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })

  test('Given 指定已打包 Xcodes When 解析准备参数 Then desktopLaunch 使用该绝对可执行文件', () => {
    const options = parsePrepareOptions([
      '--app-executable',
      '/Applications/Xcodes.app/Contents/MacOS/Xcodes',
    ])
    expect(options).toEqual({
      desktopExecutable: '/Applications/Xcodes.app/Contents/MacOS/Xcodes',
    })
    expect(createFixtureExecutionPlan(options, '/repo/Electron')).toEqual({
      desktopExecutable: '/Applications/Xcodes.app/Contents/MacOS/Xcodes',
      desktopArgs: [],
      seedProviderChannel: false,
    })
    expect(() => parsePrepareOptions(['--app-executable', 'relative/Xcodes'])).toThrow('绝对路径')
  })

  test('Given 正式包验收 When 构建 seed 环境 Then 启动前保持隔离且明确禁止 dev Electron 预置渠道', () => {
    const environment = createSeedProcessEnvironment({
      PATH: '/usr/bin',
      HOME: '/Users/real-user',
      ANTHROPIC_API_KEY: 'real-secret',
    }, paths, {
      baseUrl: 'http://127.0.0.1:4123',
      projectPath: '/tmp/fixture/project',
      seedProviderChannel: false,
    })

    expect(environment.HOME).toBe(paths.home)
    expect(environment.XCODES_DATA_ROOT).toBe(paths.dataRoot)
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined()
    expect(environment.XCODES_NATIVE_UI_SEED_PROVIDER_CHANNEL).toBe('false')
    expect(environment.XCODES_NATIVE_UI_BASE_URL).toBe('http://127.0.0.1:4123')
  })

  test('Given 正式包不预置渠道 When 生成 manifest 指引 Then 目标应用获得完整 loopback 渠道参数', () => {
    expect(createProviderChannelSetup('http://127.0.0.1:4123', false)).toEqual({
      setupMode: 'create-in-target-app',
      name: '隔离 Fake Anthropic',
      provider: 'anthropic-compatible',
      baseUrl: 'http://127.0.0.1:4123',
      apiKey: 'fixture-api-key-not-valid-outside-loopback',
      model: {
        id: 'claude-native-interactions-fixture',
        name: 'Fixture Claude',
        contextWindow: 200_000,
      },
    })
  })

  test('Given 未指定正式包 When 构建执行计划 Then dev 到 dev 仍自动预置渠道', () => {
    const plan = createFixtureExecutionPlan({}, '/repo/Electron')
    expect(plan.desktopExecutable).toBe('/repo/Electron')
    expect(plan.desktopArgs).toHaveLength(1)
    expect(plan.desktopArgs[0]?.endsWith('/apps/electron')).toBe(true)
    expect(plan.seedProviderChannel).toBe(true)
  })

  test('Given 创建验收数据 When 读取场景清单 Then 文本、工具、问答、计划和双后台任务均有稳定证据', () => {
    const scenarios = createScenarioPrompts('/tmp/fixture/project')
    const evidence = createExpectedEvidence()

    expect(Object.keys(scenarios).sort()).toEqual([
      'askUser',
      'plan',
      'text',
      'tool',
      'twoBackgroundTasks',
    ])
    expect(Object.keys(evidence).sort()).toEqual(Object.keys(scenarios).sort())
    expect(scenarios.plan).toContain('/tmp/fixture/project/plan-approved.txt')
    expect(evidence.twoBackgroundTasks).toContain('后台任务 A')
  })
})

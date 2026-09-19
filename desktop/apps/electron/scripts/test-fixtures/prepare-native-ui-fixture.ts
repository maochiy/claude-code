import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { startNativeInteractionsAnthropicServer } from '../../../local-service/test/fixtures/native-interactions-anthropic-server'

interface SeedResult {
  channelId?: string
  modelId?: string
  providerChannelSeeded: boolean
  workspaceId: string
  projectPath: string
  profileName: string
}

export interface FixtureProviderChannelSetup {
  setupMode: 'preseeded' | 'create-in-target-app'
  name: string
  provider: 'anthropic-compatible'
  baseUrl: string
  apiKey: string
  model: {
    id: string
    name: string
    contextWindow: number
  }
}

export interface FixtureManifest {
  root: string
  dataRoot: string
  home: string
  claudeConfigDir: string
  projectPath: string
  providerBaseUrl: string
  providerChannel: FixtureProviderChannelSetup
  requestMetricsUrl: string
  desktopLaunch: {
    executable: string
    args: string[]
    env: Record<string, string>
  }
  scenarios: Record<string, string>
  expectedEvidence: Record<string, string>
  seed: SeedResult
}

export interface FixtureIsolationPaths {
  home: string
  dataRoot: string
  claudeConfigDir: string
  configHome: string
  cacheHome: string
}

interface PrepareOptions {
  desktopExecutable?: string
}

export interface FixtureExecutionPlan {
  desktopExecutable: string
  desktopArgs: string[]
  seedProviderChannel: boolean
}

const repositoryRoot = resolve(import.meta.dir, '../../../..')
const electronDirectory = join(repositoryRoot, 'apps/electron')
const seedEntry = join(import.meta.dir, 'native-ui-seed-main.ts')
const esbuildExecutable = join(repositoryRoot, 'node_modules/.bin/esbuild')

export function resolveElectronExecutable(): string {
  if (process.platform === 'darwin') {
    return join(repositoryRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  }
  if (process.platform === 'win32') {
    return join(repositoryRoot, 'node_modules/electron/dist/electron.exe')
  }
  return join(repositoryRoot, 'node_modules/electron/dist/electron')
}

const PLATFORM_ENVIRONMENT_KEYS = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
] as const

/** 只保留启动 Electron/Git 所需的平台变量，禁止继承真实 Provider 凭据与用户配置。 */
export function createIsolatedChildEnvironment(
  source: NodeJS.ProcessEnv,
  paths: FixtureIsolationPaths,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const key of PLATFORM_ENVIRONMENT_KEYS) {
    const value = source[key]
    if (value) environment[key] = value
  }
  return {
    ...environment,
    HOME: paths.home,
    USER: 'xcodes-fixture',
    LOGNAME: 'xcodes-fixture',
    XCODES_DATA_ROOT: paths.dataRoot,
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    XDG_CONFIG_HOME: paths.configHome,
    XDG_CACHE_HOME: paths.cacheHome,
    ...overrides,
  }
}

export function parsePrepareOptions(argv: string[]): PrepareOptions {
  let desktopExecutable: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--app-executable' || argument === '--desktop-executable') {
      const value = argv[index + 1]?.trim()
      if (!value) throw new Error(`${argument} 缺少路径`)
      if (!isAbsolute(value)) throw new Error(`${argument} 必须是绝对路径`)
      desktopExecutable = value
      index += 1
      continue
    }
    throw new Error(`未知参数：${argument}`)
  }
  return { desktopExecutable }
}

/**
 * 开发版仅与开发版共享 safeStorage 身份，可以自动预置渠道。
 * 指定正式包时必须由目标应用自身在 UI 中创建渠道，禁止 dev Electron 生成密文。
 */
export function createFixtureExecutionPlan(
  options: PrepareOptions,
  seedElectronExecutable = resolveElectronExecutable(),
): FixtureExecutionPlan {
  if (options.desktopExecutable) {
    return {
      desktopExecutable: options.desktopExecutable,
      desktopArgs: [],
      seedProviderChannel: false,
    }
  }
  return {
    desktopExecutable: seedElectronExecutable,
    desktopArgs: [electronDirectory],
    seedProviderChannel: true,
  }
}

export function createProviderChannelSetup(
  baseUrl: string,
  seedProviderChannel: boolean,
): FixtureProviderChannelSetup {
  return {
    setupMode: seedProviderChannel ? 'preseeded' : 'create-in-target-app',
    name: '隔离 Fake Anthropic',
    provider: 'anthropic-compatible',
    baseUrl,
    apiKey: 'fixture-api-key-not-valid-outside-loopback',
    model: {
      id: 'claude-native-interactions-fixture',
      name: 'Fixture Claude',
      contextWindow: 200_000,
    },
  }
}

export function createSeedProcessEnvironment(
  source: NodeJS.ProcessEnv,
  paths: FixtureIsolationPaths,
  input: {
    baseUrl: string
    projectPath: string
    seedProviderChannel: boolean
  },
): Record<string, string> {
  return createIsolatedChildEnvironment(source, paths, {
    XCODES_NATIVE_UI_BASE_URL: input.baseUrl,
    XCODES_NATIVE_UI_PROJECT_PATH: input.projectPath,
    XCODES_NATIVE_UI_SEED_PROVIDER_CHANNEL: input.seedProviderChannel ? 'true' : 'false',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  })
}

export function createScenarioPrompts(projectPath: string): Record<string, string> {
  return {
    text: 'NATIVE_INTERACTION_UI_TEXT',
    plan: `NATIVE_INTERACTION_EXIT_PLAN TARGET_PATH=${join(projectPath, 'plan-approved.txt')}`,
    askUser: 'NATIVE_INTERACTION_ASK_MULTI',
    tool: `NATIVE_INTERACTION_UI_TOOL TARGET_PATH=${join(projectPath, 'fixture-note.txt')}`,
    twoBackgroundTasks: `NATIVE_INTERACTION_UI_BACKGROUND_TASKS TARGET_PATH=${projectPath}`,
  }
}

export function createExpectedEvidence(): Record<string, string> {
  return {
    text: '这是隔离 UI fixture 的持续流式正文',
    plan: 'Initial isolated implementation plan.',
    askUser: 'Which isolated implementation should be used?',
    tool: '隔离文件读取工具已完成。',
    twoBackgroundTasks: '运行隔离后台任务 A / 运行隔离后台任务 B',
  }
}

async function run(command: string[], env: Record<string, string>): Promise<string> {
  const processHandle = Bun.spawn(command, {
    cwd: repositoryRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`命令执行失败 (${exitCode}): ${command[0]}\n${stderr || stdout}`)
  }
  return stdout
}

async function initializeGitProject(
  projectPath: string,
  environment: Record<string, string>,
): Promise<void> {
  await mkdir(projectPath, { recursive: true })
  await writeFile(
    join(projectPath, 'fixture-note.txt'),
    '这是隔离 UI fixture 的只读工具目标。\n',
    'utf8',
  )
  await run(['git', 'init', '--quiet', projectPath], environment)
  await run(['git', '-C', projectPath, 'add', 'fixture-note.txt'], environment)
  await run([
    'git',
    '-C', projectPath,
    '-c', 'user.name=Xcodes UI Fixture',
    '-c', 'user.email=fixture@invalid.local',
    'commit', '--quiet', '-m', 'seed isolated UI fixture',
  ], environment)
}

function parseSeedResult(output: string): SeedResult {
  const prefix = 'NATIVE_UI_SEED_RESULT='
  const line = output.split('\n').find(candidate => candidate.startsWith(prefix))
  if (!line) throw new Error(`seed 进程未返回结果：${output}`)
  return JSON.parse(line.slice(prefix.length)) as SeedResult
}

async function buildSeedMain(
  outputPath: string,
  environment: Record<string, string>,
): Promise<void> {
  await run([
    esbuildExecutable,
    seedEntry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${outputPath}`,
    '--external:electron',
    '--external:node-pty',
  ], environment)
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parsePrepareOptions(argv)
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'xcodes-native-ui-'))
  const dataRoot = join(fixtureRoot, 'desktop-data')
  const isolatedHome = join(fixtureRoot, 'home')
  const claudeConfigDir = join(fixtureRoot, 'claude-config')
  const configHome = join(fixtureRoot, 'xdg-config')
  const cacheHome = join(fixtureRoot, 'xdg-cache')
  const projectPath = join(fixtureRoot, 'fixture-project')
  const seedBundle = join(fixtureRoot, 'native-ui-seed.cjs')
  const seedElectronExecutable = resolveElectronExecutable()
  const executionPlan = createFixtureExecutionPlan(options, seedElectronExecutable)

  const isolationPaths: FixtureIsolationPaths = {
    home: isolatedHome,
    dataRoot,
    claudeConfigDir,
    configHome,
    cacheHome,
  }
  const isolatedEnvironment = createIsolatedChildEnvironment(process.env, isolationPaths)

  if (!existsSync(seedElectronExecutable)) throw new Error(`未找到 seed Electron：${seedElectronExecutable}`)
  if (!existsSync(executionPlan.desktopExecutable)) {
    throw new Error(`未找到桌面可执行文件：${executionPlan.desktopExecutable}`)
  }
  if (!existsSync(esbuildExecutable)) throw new Error(`未找到 esbuild：${esbuildExecutable}`)

  await Promise.all([
    mkdir(dataRoot, { recursive: true }),
    mkdir(isolatedHome, { recursive: true }),
    mkdir(claudeConfigDir, { recursive: true }),
    mkdir(configHome, { recursive: true }),
    mkdir(cacheHome, { recursive: true }),
    mkdir(join(dataRoot, 'default-skills'), { recursive: true }),
  ])
  await initializeGitProject(projectPath, isolatedEnvironment)

  const server = startNativeInteractionsAnthropicServer({
    eventDelayMs: 140,
    // 为真实鼠标验收保留 Running 状态，便于观察双任务面板和单独停止行为。
    backgroundTaskDelaySeconds: 120,
    onFirstEvent(request) {
      console.log(`NATIVE_UI_FIRST_EVENT=${JSON.stringify({
        scenario: request.scenario,
        ordinal: request.ordinal,
        receivedAtMs: request.receivedAtMs,
        firstEventAtMs: request.firstEventAtMs,
        firstEventDelayMs: request.firstEventDelayMs,
      })}`)
    },
  })

  try {
    await buildSeedMain(seedBundle, isolatedEnvironment)
    const seedOutput = await run(
      [seedElectronExecutable, seedBundle],
      createSeedProcessEnvironment(process.env, isolationPaths, {
        baseUrl: server.baseUrl,
        projectPath,
        seedProviderChannel: executionPlan.seedProviderChannel,
      }),
    )
    const seed = parseSeedResult(seedOutput)
    if (seed.providerChannelSeeded !== executionPlan.seedProviderChannel) {
      throw new Error('seed 返回的渠道预置状态与执行计划不一致')
    }
    const manifest: FixtureManifest = {
      root: fixtureRoot,
      dataRoot,
      home: isolatedHome,
      claudeConfigDir,
      projectPath,
      providerBaseUrl: server.baseUrl,
      providerChannel: createProviderChannelSetup(server.baseUrl, executionPlan.seedProviderChannel),
      requestMetricsUrl: `${server.baseUrl}/fixture/requests`,
      desktopLaunch: {
        executable: executionPlan.desktopExecutable,
        args: executionPlan.desktopArgs,
        env: isolatedEnvironment,
      },
      scenarios: createScenarioPrompts(projectPath),
      expectedEvidence: createExpectedEvidence(),
      seed,
    }
    const manifestPath = join(fixtureRoot, 'fixture-manifest.json')
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    console.log(`NATIVE_UI_FIXTURE_READY=${JSON.stringify({
      manifestPath,
      root: fixtureRoot,
      dataRoot,
      projectPath,
      providerBaseUrl: server.baseUrl,
      requestMetricsUrl: manifest.requestMetricsUrl,
      desktopExecutable: executionPlan.desktopExecutable,
      providerChannelSetupMode: manifest.providerChannel.setupMode,
    })}`)
    console.log('UI fixture 已就绪；进程会保持 loopback Provider 在线，按 Ctrl+C 停止。')
    console.log('读取 fixture-manifest.json 的 desktopLaunch.executable、args、env 启动成品；不要复用当前 shell 的环境变量。')
    if (manifest.providerChannel.setupMode === 'create-in-target-app') {
      console.log('正式包验收不预置渠道密文；请在目标应用的模型配置 UI 中按 providerChannel 字段创建隔离渠道。')
    }

    await new Promise<void>((resolveStop) => {
      process.once('SIGINT', resolveStop)
      process.once('SIGTERM', resolveStop)
    })
  } finally {
    server.stop()
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('[UI fixture] 准备失败:', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

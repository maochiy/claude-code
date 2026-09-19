#!/usr/bin/env bun
/**
 * 逐文件运行 Bun 测试，避免同一进程内的 mock.module 与全局状态相互污染。
 *
 * 默认发现 src、packages、scripts、tests 下的 *.test.* / *.spec.* 文件；
 * 每个文件使用独立进程、HOME、CLAUDE_CONFIG_DIR 和临时目录。
 */

import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const discoveryRoots = ['src', 'packages', 'scripts', 'tests'] as const
const excludedDirectories = new Set([
  '.git',
  'coverage',
  'desktop',
  'dist',
  'dist-desktop',
  'node_modules',
])
const testFilePattern = /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/
const defaultConcurrency = 4
const defaultTimeoutMs = 180_000

interface RunnerOptions {
  concurrency: number
  timeoutMs: number
  outputDirectory: string
  filter?: string
  listOnly: boolean
  selectors: string[]
}

interface TestResult {
  file: string
  status: 'passed' | 'failed' | 'timeout' | 'spawn_error'
  exitCode: number | null
  durationMs: number
  tempDirectory: string
  logFile: string | null
  error?: string
}

interface ResultDocument {
  version: 1
  startedAt: string
  finishedAt: string | null
  repoRoot: string
  command: string[]
  options: {
    concurrency: number
    timeoutMs: number
    filter: string | null
  }
  discovered: number
  selected: number
  completed: number
  passed: number
  failed: number
  interrupted: boolean
  results: TestResult[]
}

function usage(): string {
  return `Usage: bun run scripts/test-isolated.ts [options] [test-file-or-directory ...]

Options:
  -j, --concurrency <n>  并发测试进程数（默认 ${defaultConcurrency}）
  -t, --timeout <ms>     单文件超时毫秒数（默认 ${defaultTimeoutMs}）
  -o, --output <dir>     JSON 与失败日志目录（默认 VALIDATION_EVIDENCE/cli-tests 或系统临时目录）
  -f, --filter <text>    按仓库相对路径包含文本过滤
      --list             只列出文件，不运行
  -h, --help             显示帮助

未传路径时扫描 src、packages、scripts、tests；不会扫描 desktop、dist 或 node_modules。`
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} 必须是正整数，收到：${value}`)
  }
  return parsed
}

function parseArguments(argv: string[]): RunnerOptions {
  let concurrency = defaultConcurrency
  let timeoutMs = defaultTimeoutMs
  const validationEvidence = process.env.VALIDATION_EVIDENCE?.trim()
  let outputDirectory = validationEvidence
    ? resolve(repoRoot, validationEvidence, 'cli-tests')
    : join(
        tmpdir(),
        'claude-code-isolated-tests',
        new Date().toISOString().replaceAll(':', '-'),
      )
  let filter: string | undefined
  let listOnly = false
  const selectors: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    const nextValue = (): string => {
      const value = argv[index + 1]
      if (!value) throw new Error(`${argument} 缺少参数`)
      index += 1
      return value
    }
    if (argument === '-h' || argument === '--help') {
      console.log(usage())
      process.exit(0)
    } else if (argument === '-j' || argument === '--concurrency') {
      concurrency = positiveInteger(nextValue(), argument)
    } else if (argument.startsWith('--concurrency=')) {
      concurrency = positiveInteger(
        argument.slice('--concurrency='.length),
        '--concurrency',
      )
    } else if (argument === '-t' || argument === '--timeout') {
      timeoutMs = positiveInteger(nextValue(), argument)
    } else if (argument.startsWith('--timeout=')) {
      timeoutMs = positiveInteger(
        argument.slice('--timeout='.length),
        '--timeout',
      )
    } else if (argument === '-o' || argument === '--output') {
      outputDirectory = resolve(repoRoot, nextValue())
    } else if (argument.startsWith('--output=')) {
      outputDirectory = resolve(repoRoot, argument.slice('--output='.length))
    } else if (argument === '-f' || argument === '--filter') {
      filter = nextValue()
    } else if (argument.startsWith('--filter=')) {
      filter = argument.slice('--filter='.length)
    } else if (argument === '--list') {
      listOnly = true
    } else if (argument === '--') {
      selectors.push(...argv.slice(index + 1))
      break
    } else if (argument.startsWith('-')) {
      throw new Error(`未知参数：${argument}`)
    } else {
      selectors.push(argument)
    }
  }

  return {
    concurrency: Math.min(concurrency, 16),
    timeoutMs,
    outputDirectory,
    ...(filter ? { filter } : {}),
    listOnly,
    selectors,
  }
}

async function discoverInDirectory(directory: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) {
        files.push(...(await discoverInDirectory(path)))
      }
    } else if (entry.isFile() && testFilePattern.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code?: string }).code === 'ENOENT'
  )
}

async function discoverOptionalRoot(directory: string): Promise<string[]> {
  try {
    return await discoverInDirectory(directory)
  } catch (error) {
    if (isMissingPath(error)) return []
    throw error
  }
}

function assertAllowedSelector(path: string, selector: string): void {
  const relativePath = relative(repoRoot, path)
  const segments = relativePath.split(/[\\/]+/)
  if (
    relativePath === '' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativePath) ||
    !discoveryRoots.includes(segments[0] as (typeof discoveryRoots)[number]) ||
    segments.some(segment => excludedDirectories.has(segment))
  ) {
    throw new Error(`测试路径超出允许范围：${selector}`)
  }
}

async function discoverTests(selectors: string[]): Promise<{
  discovered: number
  files: string[]
}> {
  const allDiscovered = (
    await Promise.all(
      discoveryRoots.map(async root => {
        const path = join(repoRoot, root)
        return discoverOptionalRoot(path)
      }),
    )
  ).flat()
  const uniqueDiscovered = [
    ...new Set(allDiscovered.map(path => resolve(path))),
  ].sort((left, right) => left.localeCompare(right))

  if (selectors.length === 0) {
    return { discovered: uniqueDiscovered.length, files: uniqueDiscovered }
  }

  const selected: string[] = []
  for (const selector of selectors) {
    const path = isAbsolute(selector)
      ? resolve(selector)
      : resolve(repoRoot, selector)
    assertAllowedSelector(path, selector)
    const details = await stat(path).catch(() => null)
    if (!details) throw new Error(`测试路径不存在：${selector}`)
    if (details.isDirectory()) {
      selected.push(...(await discoverInDirectory(path)))
    } else if (details.isFile() && testFilePattern.test(basename(path))) {
      selected.push(path)
    } else {
      throw new Error(`不是支持的测试文件：${selector}`)
    }
  }
  const uniqueSelected = [...new Set(selected.map(path => resolve(path)))].sort(
    (left, right) => left.localeCompare(right),
  )
  return { discovered: uniqueDiscovered.length, files: uniqueSelected }
}

function safeEnvironment(fixtureRoot: string): Record<string, string> {
  const inheritedKeys = [
    'COMSPEC',
    'LANG',
    'LC_ALL',
    'PATH',
    'PATHEXT',
    'SHELL',
    'SystemRoot',
    'TERM',
    'USER',
    'USERNAME',
    'windir',
  ] as const
  const environment: Record<string, string> = {}
  for (const key of inheritedKeys) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  const home = join(fixtureRoot, 'home')
  const config = join(fixtureRoot, 'claude-config')
  const temporary = join(fixtureRoot, 'tmp')
  return {
    ...environment,
    // 不继承 XDG 覆盖；默认 XDG 路径仍落在此隔离 HOME 内。
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: config,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    PWD: repoRoot,
    NODE_ENV: 'test',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_TELEMETRY: '1',
    DISABLE_TELEMETRY: '1',
  }
}

function logName(file: string, index: number): string {
  const relativePath = relative(repoRoot, file)
  const safePath = relativePath.replaceAll(/[^A-Za-z0-9._-]+/g, '_')
  return `${String(index + 1).padStart(4, '0')}-${safePath}.log`
}

function signalProcessGroup(
  subprocess: ReturnType<typeof Bun.spawn>,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-subprocess.pid, signal)
  } catch {
    try {
      subprocess.kill(signal)
    } catch {
      // 进程组可能已经完全退出。
    }
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

function isSubprocessRunning(
  subprocess: ReturnType<typeof Bun.spawn>,
): boolean {
  return subprocess.exitCode === null && subprocess.signalCode === null
}

async function terminateProcessTreeOnce(
  subprocess: ReturnType<typeof Bun.spawn>,
  graceMs: number,
): Promise<void> {
  if (process.platform === 'win32') {
    // 父进程已退出后再 taskkill 可能误伤复用的 PID。Windows 上如需可靠回收
    // 已脱离父进程的后代，需要额外使用 Job Object；当前只清理由 runner
    // 仍持有的活跃进程树。
    if (!isSubprocessRunning(subprocess)) return
    Bun.spawnSync(['taskkill', '/PID', String(subprocess.pid), '/T', '/F'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await Promise.race([
      subprocess.exited.catch(() => -1),
      Bun.sleep(Math.max(graceMs, 250)),
    ])
    if (isSubprocessRunning(subprocess)) {
      try {
        subprocess.kill('SIGKILL')
      } catch {
        // taskkill 可能已经完成清理。
      }
      await Promise.race([subprocess.exited.catch(() => -1), Bun.sleep(250)])
    }
    return
  }

  signalProcessGroup(subprocess, 'SIGTERM')
  if (processGroupExists(subprocess.pid)) await Bun.sleep(graceMs)
  if (processGroupExists(subprocess.pid))
    signalProcessGroup(subprocess, 'SIGKILL')
  await Promise.race([subprocess.exited.catch(() => -1), Bun.sleep(250)])
}

const processCleanup = new WeakMap<
  ReturnType<typeof Bun.spawn>,
  Promise<void>
>()

function terminateProcessTree(
  subprocess: ReturnType<typeof Bun.spawn>,
  graceMs: number,
): Promise<void> {
  const existing = processCleanup.get(subprocess)
  if (existing) return existing
  const cleanup = terminateProcessTreeOnce(subprocess, graceMs).finally(() => {
    processCleanup.delete(subprocess)
  })
  processCleanup.set(subprocess, cleanup)
  return cleanup
}

async function runOne(
  file: string,
  index: number,
  options: RunnerOptions,
  activeProcesses: Map<number, ReturnType<typeof Bun.spawn>>,
): Promise<TestResult> {
  const startedAt = Date.now()
  // POSIX socket 路径有长度上限，隔离测试使用短的私有临时目录。
  const fixtureRoot = await mkdtemp(
    join(process.platform === 'win32' ? tmpdir() : '/tmp', 'ccb-test-'),
  )
  const fixtureDirectories = [
    join(fixtureRoot, 'home'),
    join(fixtureRoot, 'claude-config'),
    join(fixtureRoot, 'tmp'),
  ]
  await Promise.all(
    fixtureDirectories.map(path => mkdir(path, { recursive: true })),
  )
  const temporaryLog = join(fixtureRoot, 'test.log')
  const logHandle = await open(temporaryLog, 'w')
  let subprocess: ReturnType<typeof Bun.spawn> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let timedOut = false

  try {
    subprocess = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        'test',
        '--timeout',
        String(Math.min(30_000, options.timeoutMs)),
        file,
      ],
      {
        cwd: repoRoot,
        env: safeEnvironment(fixtureRoot),
        stdin: 'ignore',
        stdout: logHandle.fd,
        stderr: logHandle.fd,
        detached: process.platform !== 'win32',
      },
    )
    activeProcesses.set(subprocess.pid, subprocess)
    const timeoutResult = new Promise<null>(resolveTimeout => {
      timeout = setTimeout(() => resolveTimeout(null), options.timeoutMs)
    })
    const exitCode = await Promise.race([subprocess.exited, timeoutResult])
    if (exitCode === null) {
      timedOut = true
      await terminateProcessTree(subprocess, 1_000)
    } else {
      // 测试进程已结束，仍清理它可能遗留的 fixture 子进程。
      await terminateProcessTree(subprocess, 250)
    }
    if (timeout) clearTimeout(timeout)
    await logHandle.close()

    const status: TestResult['status'] = timedOut
      ? 'timeout'
      : exitCode === 0
        ? 'passed'
        : 'failed'
    let failureLog: string | null = null
    if (status !== 'passed') {
      failureLog = join(options.outputDirectory, 'logs', logName(file, index))
      await mkdir(dirname(failureLog), { recursive: true })
      await copyFile(temporaryLog, failureLog)
    }
    return {
      file: relative(repoRoot, file),
      status,
      exitCode: timedOut ? null : exitCode,
      durationMs: Date.now() - startedAt,
      tempDirectory: fixtureRoot,
      logFile: failureLog,
    }
  } catch (error) {
    if (timeout) clearTimeout(timeout)
    if (subprocess)
      await terminateProcessTree(subprocess, 250).catch(() => undefined)
    await logHandle.close().catch(() => undefined)
    const failureLog = join(
      options.outputDirectory,
      'logs',
      logName(file, index),
    )
    await mkdir(dirname(failureLog), { recursive: true })
    await copyFile(temporaryLog, failureLog).catch(() => undefined)
    return {
      file: relative(repoRoot, file),
      status: 'spawn_error',
      exitCode: null,
      durationMs: Date.now() - startedAt,
      tempDirectory: fixtureRoot,
      logFile: failureLog,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (subprocess) activeProcesses.delete(subprocess.pid)
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}

async function writeResults(
  path: string,
  document: ResultDocument,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const discovery = await discoverTests(options.selectors)
  const files = options.filter
    ? discovery.files.filter(file =>
        relative(repoRoot, file).includes(options.filter!),
      )
    : discovery.files

  if (options.listOnly) {
    for (const file of files) console.log(relative(repoRoot, file))
    console.log(
      `\n${files.length} test files selected (${discovery.discovered} discovered).`,
    )
    return
  }
  if (files.length === 0) throw new Error('没有选中测试文件')

  await mkdir(options.outputDirectory, { recursive: true })
  const resultPath = join(options.outputDirectory, 'results.json')
  const journalPath = join(options.outputDirectory, 'results.jsonl')
  const document: ResultDocument = {
    version: 1,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    repoRoot,
    command: process.argv,
    options: {
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      filter: options.filter ?? null,
    },
    discovered: discovery.discovered,
    selected: files.length,
    completed: 0,
    passed: 0,
    failed: 0,
    interrupted: false,
    results: [],
  }
  await writeResults(resultPath, document)
  const activeProcesses = new Map<number, ReturnType<typeof Bun.spawn>>()
  let interrupted = false
  let interruptCleanup: Promise<void> | undefined
  const interrupt = (): void => {
    interrupted = true
    interruptCleanup ??= Promise.all(
      [...activeProcesses.values()].map(subprocess =>
        terminateProcessTree(subprocess, 1_000),
      ),
    ).then(() => undefined)
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)

  console.log(
    `发现 ${discovery.discovered} 个测试文件，运行 ${files.length} 个`,
  )
  console.log(`并发 ${options.concurrency}，单文件超时 ${options.timeoutMs}ms`)
  console.log(`结果目录：${options.outputDirectory}`)

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (!interrupted) {
      const index = cursor
      cursor += 1
      const file = files[index]
      if (!file) return
      const relativePath = relative(repoRoot, file)
      console.log(`[${index + 1}/${files.length}] RUN  ${relativePath}`)
      const result = await runOne(file, index, options, activeProcesses)
      document.results.push(result)
      document.completed += 1
      if (result.status === 'passed') document.passed += 1
      else document.failed += 1
      await appendFile(journalPath, `${JSON.stringify(result)}\n`, 'utf8')
      const suffix = result.logFile ? ` (${result.logFile})` : ''
      console.log(
        `[${index + 1}/${files.length}] ${result.status.toUpperCase()} ${relativePath} ${result.durationMs}ms${suffix}`,
      )
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, files.length) }, () =>
      worker(),
    ),
  )
  if (interruptCleanup) await interruptCleanup
  document.finishedAt = new Date().toISOString()
  document.interrupted = interrupted
  document.results.sort((left, right) => left.file.localeCompare(right.file))
  await writeResults(resultPath, document)

  console.log(
    `完成 ${document.completed}/${document.selected}：${document.passed} passed，${document.failed} failed`,
  )
  if (interrupted) process.exitCode = 130
  else if (document.failed > 0 || document.completed !== document.selected)
    process.exitCode = 1
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

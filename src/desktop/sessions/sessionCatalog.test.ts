import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import type { Message } from '../../types/message.js'

type SessionListResult = Awaited<
  ReturnType<typeof import('../../utils/listSessionsImpl.js').listSessionsImpl>
>
type SessionLog = Awaited<
  ReturnType<typeof import('../../utils/sessionStorage.js').getLastSessionLog>
>
type ResolvedSessionFile = Awaited<
  ReturnType<
    typeof import('../../utils/sessionStoragePortable.js').resolveSessionFilePath
  >
>

const listSessionsImplMock = mock(
  async (): Promise<SessionListResult> => [],
)
const getLastSessionLogMock = mock(
  async (): Promise<SessionLog> => null,
)
const toSDKMessagesMock = mock(
  (_messages: Message[]): SDKMessage[] => [],
)
const resolveSessionFilePathMock = mock(
  async (): Promise<ResolvedSessionFile> => undefined,
)
const sessionMessagesCache = new Map()

mock.module('../../bootstrap/state.js', () => ({
  setOriginalCwd: mock(() => undefined),
}))
mock.module('../bootstrap/runtimeConfiguration.js', () => ({
  applyDesktopRuntimeConfiguration: mock(() => undefined),
}))
mock.module('../../utils/listSessionsImpl.js', () => ({
  listSessionsImpl: listSessionsImplMock,
}))
mock.module('../../utils/sessionStorage.js', () => ({
  getLastSessionLog: getLastSessionLogMock,
  getSessionMessagesCache: () => sessionMessagesCache,
}))
mock.module('../../utils/messages/mappers.js', () => ({
  toSDKMessages: toSDKMessagesMock,
}))
mock.module('../../utils/sessionStoragePortable.js', () => ({
  resolveSessionFilePath: resolveSessionFilePathMock,
}))

type SessionCatalogModule = typeof import('./sessionCatalog.js')

let sessionCatalog: SessionCatalogModule
let projectDir: string
const originalCwd = process.cwd()

beforeAll(async () => {
  sessionCatalog = await import('./sessionCatalog.js')
})

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ccb-desktop-session-catalog-'))
  listSessionsImplMock.mockReset()
  getLastSessionLogMock.mockReset()
  toSDKMessagesMock.mockReset()
  resolveSessionFilePathMock.mockReset()
  sessionMessagesCache.clear()
})

afterAll(async () => {
  process.chdir(originalCwd)
})

afterEach(async () => {
  process.chdir(originalCwd)
  if (projectDir) {
    await rm(projectDir, { recursive: true, force: true })
  }
})

function environment() {
  return {
    variables: {},
    configDir: join(projectDir, '.ccb'),
  }
}

describe('Desktop Runtime CCB Session Catalog', () => {
  test('Given 项目 cwd When 读取目录 Then 只调用 CCB 原生 listSessionsImpl 并映射 Runtime 字段', async () => {
    listSessionsImplMock.mockResolvedValue([
      {
        sessionId: 'ccb-session-1',
        customTitle: '项目会话',
        summary: '会话摘要',
        cwd: projectDir,
        createdAt: 10,
        lastModified: 20,
        gitBranch: 'main',
        tag: 'desktop',
      },
    ])

    const result = await sessionCatalog.resolveDesktopSessionCatalog({
      cwd: projectDir,
      environment: environment(),
      limit: 500,
      offset: 0,
    })

    expect(listSessionsImplMock).toHaveBeenCalledWith({
      dir: projectDir,
      limit: 500,
      offset: 0,
      includeWorktrees: true,
    })
    expect(result.sessions).toEqual([
      {
        runtimeSessionId: 'ccb-session-1',
        title: '项目会话',
        summary: '会话摘要',
        cwd: projectDir,
        createdAt: 10,
        updatedAt: 20,
        gitBranch: 'main',
        tag: 'desktop',
      },
    ])
  })

  test('Given CCB Transcript When 读取内容 Then 使用 toSDKMessages 输出桌面 wire shape', async () => {
    getLastSessionLogMock.mockResolvedValue({
      sessionId: 'ccb-session-1',
      messages: [{ type: 'assistant' } as Message],
    } as SessionLog)
    toSDKMessagesMock.mockReturnValue([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '完成' }] },
      } as SDKMessage,
    ])

    const result = await sessionCatalog.resolveDesktopSessionTranscript({
      cwd: projectDir,
      environment: environment(),
      runtimeSessionId: 'ccb-session-1',
    })

    expect(getLastSessionLogMock).toHaveBeenCalledWith('ccb-session-1')
    expect(toSDKMessagesMock).toHaveBeenCalledTimes(1)
    expect(result.messages[0]).toMatchObject({
      type: 'assistant',
      session_id: 'ccb-session-1',
      message: { content: [{ type: 'text', text: '完成' }] },
    })
  })

  test('Given CCB Transcript 与附属目录 When 删除会话 Then 原生数据和消息缓存都被清理', async () => {
    const transcriptPath = join(projectDir, 'ccb-session-1.jsonl')
    const sidecarDir = join(projectDir, 'ccb-session-1')
    mkdirSync(sidecarDir, { recursive: true })
    writeFileSync(transcriptPath, '{"type":"user"}\n', 'utf8')
    writeFileSync(join(sidecarDir, 'task.json'), '{}', 'utf8')
    sessionMessagesCache.set('ccb-session-1', Promise.resolve(new Set()))
    resolveSessionFilePathMock.mockResolvedValue({
      filePath: transcriptPath,
      projectPath: projectDir,
      fileSize: 16,
    })

    const result = await sessionCatalog.deleteDesktopSession({
      cwd: projectDir,
      environment: environment(),
      runtimeSessionId: 'ccb-session-1',
    })

    expect(result).toEqual({ deleted: true })
    expect(existsSync(transcriptPath)).toBe(false)
    expect(existsSync(sidecarDir)).toBe(false)
    expect(sessionMessagesCache.has('ccb-session-1')).toBe(false)
  })
})

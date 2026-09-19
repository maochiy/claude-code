import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: {},
  clipboard: {},
  nativeTheme: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))

let buildAgentMessageContent: typeof import('./message-content').buildAgentMessageContent

beforeAll(async () => {
  buildAgentMessageContent = (await import('./message-content')).buildAgentMessageContent
})

const fixtures: string[] = []

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'proma-agent-image-'))
  fixtures.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Agent CLI 图片消息', () => {
  test('Given 会话附件目录内图片 When 构造消息 Then 生成原生 base64 image block', () => {
    const root = fixture()
    const sessionDirectory = join(root, 'session')
    mkdirSync(sessionDirectory)
    const image = join(sessionDirectory, 'preview.png')
    writeFileSync(image, Buffer.from('image-data'))

    expect(buildAgentMessageContent({
      text: '分析这张图',
      sessionAttachmentDirectory: sessionDirectory,
      attachments: [{ filename: 'preview.png', mediaType: 'image/png', localPath: image }],
    })).toEqual([
      { type: 'text', text: '分析这张图' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from('image-data').toString('base64'),
        },
      },
    ])
  })

  test('Given 用户已明确附加外部图片 When 构造消息 Then 仅允许精确匹配的文件', () => {
    const root = fixture()
    const sessionDirectory = join(root, 'session')
    mkdirSync(sessionDirectory)
    const image = join(root, 'selected.webp')
    writeFileSync(image, Buffer.from('selected'))

    expect(buildAgentMessageContent({
      text: '查看',
      sessionAttachmentDirectory: sessionDirectory,
      allowedAttachmentFiles: [image],
      attachments: [{ filename: 'selected.webp', mediaType: 'image/webp', localPath: image }],
    })?.[1]).toMatchObject({ type: 'image' })
  })

  test('Given 会话目录内软链接指向未授权文件 When 构造消息 Then 拒绝读取', () => {
    const root = fixture()
    const sessionDirectory = join(root, 'session')
    mkdirSync(sessionDirectory)
    const outside = join(root, 'secret.png')
    writeFileSync(outside, Buffer.from('secret'))
    const linked = join(sessionDirectory, 'linked.png')
    symlinkSync(outside, linked)

    expect(() => buildAgentMessageContent({
      text: '查看',
      sessionAttachmentDirectory: sessionDirectory,
      attachments: [{ filename: 'linked.png', mediaType: 'image/png', localPath: linked }],
    })).toThrow('不在当前会话允许范围内')
  })

  test('Given 文档附件 When 构造消息 Then 保持文本路径流程且不读取为图片', () => {
    expect(buildAgentMessageContent({
      text: '阅读文档',
      sessionAttachmentDirectory: fixture(),
      attachments: [{ filename: 'notes.md', mediaType: 'text/markdown', localPath: '/not/read.md' }],
    })).toBeUndefined()
  })
})

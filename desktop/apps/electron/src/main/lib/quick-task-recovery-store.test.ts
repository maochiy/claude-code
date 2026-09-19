import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QuickTaskRecoveryStore } from './quick-task-recovery-store'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createStore(now = 100): { path: string; store: QuickTaskRecoveryStore } {
  const directory = mkdtempSync(join(tmpdir(), 'proma-quick-task-'))
  directories.push(directory)
  const path = join(directory, 'quick-task-pending.json')
  return { path, store: new QuickTaskRecoveryStore(path, () => now) }
}

describe('快速任务崩溃恢复记录', () => {
  test('Given commit 后 Renderer 崩溃 When 新实例加载 Then 正文和附件引用仍可恢复且不会成为自动发送事件', () => {
    const { path, store } = createStore()
    store.stage({
      requestId: 'request-1',
      submissionId: 'submission-1',
      mode: 'chat',
      sessionId: 'conversation-1',
      title: '分析附件',
      message: '请分析附件内容',
      attachments: [{
        filename: 'report.txt',
        attachment: {
          id: 'attachment-1',
          filename: 'report.txt',
          mediaType: 'text/plain',
          localPath: 'conversation-1/attachment-1.txt',
          size: 12,
        },
      }],
    })
    expect(store.accept({ submissionId: 'submission-1', requestId: 'request-1' })?.status).toBe('accepted')

    const recovered = new QuickTaskRecoveryStore(path).listAccepted()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.message).toBe('请分析附件内容')
    expect(recovered[0]?.attachments?.[0]?.attachment?.localPath).toBe('conversation-1/attachment-1.txt')
    // 恢复 API 只列出明确待发送草稿；记录本身不包含任何自动执行标志。
    expect('autoSend' in recovered[0]!).toBe(false)
  })

  test('Given 同 submissionId 已发起新重试 When 旧请求迟到清理 Then 不删除新请求记录', () => {
    const { store } = createStore()
    store.stage({
      requestId: 'request-old', submissionId: 'same', mode: 'agent', sessionId: 's-old',
      title: '旧请求', message: '旧请求',
    })
    store.stage({
      requestId: 'request-new', submissionId: 'same', mode: 'agent', sessionId: 's-new',
      title: '新请求', message: '新请求',
    })

    expect(store.remove({ submissionId: 'same', requestId: 'request-old' })).toBe(false)
    expect(store.accept({ submissionId: 'same', requestId: 'request-new' })?.sessionId).toBe('s-new')
  })

  test('Given 发送已确认 When 清理恢复记录 Then 重启后不再提示该草稿', () => {
    const { path, store } = createStore()
    store.stage({
      requestId: 'request-done', submissionId: 'done', mode: 'agent', sessionId: 's-done',
      title: '完成', message: '完成',
    })
    store.accept({ submissionId: 'done', requestId: 'request-done' })

    expect(store.remove({ submissionId: 'done' })).toBe(true)
    expect(new QuickTaskRecoveryStore(path).listAccepted()).toEqual([])
  })

  test('Given 恢复文件 JSON 损坏 When stage 新任务 Then 失败关闭且原文件字节不变', () => {
    const { path, store } = createStore()
    const original = Buffer.from('{"version":1,"records":[', 'utf8')
    writeFileSync(path, original)

    expect(() => store.stage({
      requestId: 'request-corrupt', submissionId: 'corrupt', mode: 'chat', sessionId: 'c-corrupt',
      title: '不能覆盖', message: '保留草稿',
    })).toThrow('JSON 损坏')
    expect(readFileSync(path).equals(original)).toBe(true)
  })

  test('Given 恢复文件版本较新 When stage 新任务 Then 失败关闭且原文件字节不变', () => {
    const { path, store } = createStore()
    const original = Buffer.from(JSON.stringify({ version: 2, records: [] }, null, 4), 'utf8')
    writeFileSync(path, original)

    expect(() => store.stage({
      requestId: 'request-newer', submissionId: 'newer', mode: 'agent', sessionId: 's-newer',
      title: '不能降级', message: '保留数据',
    })).toThrow('不支持快速任务恢复记录版本 2')
    expect(readFileSync(path).equals(original)).toBe(true)
  })

  test('Given submission 已 accepted When stage 同 ID Then 存储层拒绝覆盖且原文件字节不变', () => {
    const { path, store } = createStore()
    store.stage({
      requestId: 'request-accepted', submissionId: 'accepted', mode: 'agent', sessionId: 's-accepted',
      title: '已接收', message: '原始任务',
    })
    store.accept({ submissionId: 'accepted', requestId: 'request-accepted' })
    const original = readFileSync(path)

    expect(() => store.stage({
      requestId: 'request-retry', submissionId: 'accepted', mode: 'agent', sessionId: 's-retry',
      title: '重试', message: '不能覆盖',
    })).toThrow('已被接收')
    expect(readFileSync(path).equals(original)).toBe(true)
    expect(store.listAccepted()[0]?.message).toBe('原始任务')
  })
})

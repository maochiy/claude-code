import { expect, test } from 'bun:test'
import { TaskOutputReader } from './task-output-reader'

test('后台任务轮询仅获取追加字节，日志截断后重新读取', async () => {
  const reader = new TaskOutputReader()
  let content = 'first\n'
  const cursors: number[] = []
  const read = async (cursor: number) => {
    cursors.push(cursor)
    return { task_id: 'task', content: content.slice(cursor), next_cursor: content.length, total_bytes: content.length, eof: true }
  }
  expect(await reader.read('task', read)).toBe('first\n')
  content += 'second\n'
  expect(await reader.read('task', read)).toBe(content)
  expect(cursors).toEqual([0, 6])
  content = 'new\n'
  expect(await reader.read('task', read)).toBe(content)
  expect(cursors.slice(-2)).toEqual([13, 0])
})

test('固定输出快照边界，后续增长留到下次轮询', async () => {
  const reader = new TaskOutputReader()
  let calls = 0
  const read = async (cursor: number) => {
    calls++
    return { task_id: 'task', content: 'ab', next_cursor: cursor + 2, total_bytes: calls === 1 ? 4 : 100, eof: false }
  }
  expect(await reader.read('task', read)).toBe('abab')
  expect(calls).toBe(2)
})

test('同任务并发读取合并，错误偏移不会死循环', async () => {
  const reader = new TaskOutputReader()
  let calls = 0
  const read = async () => {
    calls++
    await Promise.resolve()
    return { task_id: 'task', content: 'a', next_cursor: 1, total_bytes: 1, eof: true }
  }
  expect(await Promise.all([reader.read('task', read), reader.read('task', read)])).toEqual(['a', 'a'])
  expect(calls).toBe(1)
  await expect(reader.read('bad', async () => ({ task_id: 'bad', content: '', next_cursor: 0, total_bytes: 2, eof: false }))).rejects.toThrow('未向前推进')
})

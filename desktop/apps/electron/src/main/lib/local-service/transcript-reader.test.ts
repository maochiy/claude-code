import { expect, test } from 'bun:test'
import { readNativeTranscript } from './transcript-reader'

const page = (cursor: number, uuid: string) => ({ snapshot_id: 'fixed', cursor, next_cursor: cursor + 1,
  total: 2, eof: cursor === 1, truncated: false, messages: [{ type: 'assistant', uuid }] })
test('Given 原生历史有多页 When 恢复 Then 传递同一快照身份并保持消息顺序', async () => {
  const requests: Record<string, unknown>[] = []
  const messages = await readNativeTranscript(async request => {
    requests.push(request)
    return page(Number(request.cursor), request.cursor === 0 ? 'a' : 'b')
  })
  expect(messages.map(message => (message as Record<string, unknown>).uuid)).toEqual(['a', 'b'])
  expect(requests[1]?.snapshot_id).toBe('fixed')
})
test('Given 快照变化、截断或游标卡住 When 恢复 Then 失败而非写入不完整历史', async () => {
  for (const overrides of [{ snapshot_id: 'changed' }, { truncated: true }, { next_cursor: 1 }, { total: 3 }]) {
    await expect(readNativeTranscript(async request => request.cursor === 0
      ? page(0, 'a') : { ...page(1, 'b'), ...overrides })).rejects.toThrow()
  }
})

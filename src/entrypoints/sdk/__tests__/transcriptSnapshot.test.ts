import { describe, expect, test } from 'bun:test'
import { TranscriptSnapshot } from '../transcriptSnapshot.js'

describe('session transcript snapshot', () => {
  test('pagination uses one frozen snapshot despite live additions and in-place mutation', () => {
    const live = [
      { type: 'user', uuid: 'a', message: { text: 'first' } },
      { type: 'assistant', uuid: 'b' },
    ]
    const snapshots = new TranscriptSnapshot()
    const first = snapshots.read({ limit: 1 }, () => live)
    live[0]!.message!.text = 'changed'
    live.push({ type: 'assistant', uuid: 'c' })
    const next = snapshots.read(
      { snapshot_id: first.snapshot_id, cursor: first.next_cursor },
      () => {
        throw new Error('must not recapture')
      },
    )
    expect(first.messages[0]?.message).toEqual({ text: 'first' })
    expect(next.messages.map(message => message.uuid)).toEqual(['b'])
    expect(next.total).toBe(2)
    expect(next.eof).toBe(true)
  })
  test('unknown snapshots and unsafe continuation cursors fail', () => {
    const snapshots = new TranscriptSnapshot()
    expect(() => snapshots.read({ cursor: 1 }, () => [])).toThrow('snapshot ID')
    expect(() => snapshots.read({ snapshot_id: 'unknown' }, () => [])).toThrow(
      'expired',
    )
    expect(() => snapshots.read({ limit: 1001 }, () => [])).toThrow('Invalid')
    const result = snapshots.read({}, () => [])
    expect(() =>
      snapshots.read({ snapshot_id: result.snapshot_id, cursor: 1 }, () => []),
    ).toThrow('out of range')
  })
})

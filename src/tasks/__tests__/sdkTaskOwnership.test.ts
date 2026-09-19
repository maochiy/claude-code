import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistTaskOwnership, readTaskOwnership } from '../sdkTaskOwnership.js'
import type { SdkTaskSnapshot } from '../sdkTaskControls.js'

const task = (id: string): SdkTaskSnapshot => ({
  task_id: id,
  task_type: 'local_agent',
  status: 'completed',
  description: 'fixture',
  start_time: 1,
  duration_ms: 1,
  output_bytes: 0,
  child_task_ids: [],
  agent_id: `agent-${id}`,
  output_available: false,
  transcript_available: false,
})
test('task ownership persists across reopen without leaking another session or forgetting completed tasks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-ownership-'))
  try {
    const path = join(directory, 'a.json')
    persistTaskOwnership(path, [task('one')])
    persistTaskOwnership(path, [task('two')])
    expect(readTaskOwnership(path).map(item => item.task_id)).toEqual([
      'one',
      'two',
    ])
    expect(readTaskOwnership(join(directory, 'other-session.json'))).toEqual([])
    expect(readTaskOwnership(path)[0]?.agent_id).toBe('agent-one')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
test('corrupt or path-shaped ownership fails closed without overwriting original bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-ownership-corrupt-'))
  try {
    const path = join(directory, 'a.json')
    const raw = JSON.stringify({
      version: 1,
      tasks: [{ ...task('one'), agent_id: '../other' }],
    })
    writeFileSync(path, raw)
    expect(() => persistTaskOwnership(path, [task('two')])).toThrow('Invalid')
    expect(readFileSync(path, 'utf8')).toBe(raw)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('completed parent retains symmetric child links after partial task refreshes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-ownership-family-'))
  try {
    const path = join(directory, 'tasks.json')
    const parent = task('parent')
    const child = {
      ...task('child'),
      task_type: 'local_bash' as const,
      agent_id: parent.agent_id,
    }
    persistTaskOwnership(path, [parent])
    persistTaskOwnership(path, [child])
    expect(
      readTaskOwnership(path).find(item => item.task_id === 'parent')
        ?.child_task_ids,
    ).toEqual(['child'])
    expect(
      readTaskOwnership(path).find(item => item.task_id === 'child')
        ?.parent_task_id,
    ).toBe('parent')
    persistTaskOwnership(path, [parent])
    persistTaskOwnership(path, [{ ...child, agent_id: undefined }])
    expect(
      readTaskOwnership(path).find(item => item.task_id === 'parent')
        ?.child_task_ids,
    ).toEqual(['child'])
    expect(
      readTaskOwnership(path).find(item => item.task_id === 'child')
        ?.parent_task_id,
    ).toBe('parent')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

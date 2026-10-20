import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(__dirname, '..', '..')
const RUNNER = resolve(__dirname, 'queryTaskCompletion.runner.ts')

describe('query task completion', () => {
  test('runs all reconciliation cases without process-global mock pollution', () => {
    // Older task tests mock bootstrap state globally. Keep these real task/query
    // checks in a fresh process so tasksDisabled exercises the actual state.
    const child = spawnSync(process.execPath, ['test', RUNNER], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    })
    if (child.error || child.status !== 0) {
      throw new Error(
        `Task completion subprocess failed (exit ${child.status}):\n${child.error?.message ?? ''}\n${child.stderr}\n${child.stdout}`,
      )
    }
    expect(child.status).toBe(0)
  }, 65_000)
})

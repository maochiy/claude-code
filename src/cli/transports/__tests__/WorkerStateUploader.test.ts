import { describe, expect, test } from 'bun:test'
import { WorkerStateUploader } from '../WorkerStateUploader.js'

describe('WorkerStateUploader', () => {
  test('flushes the final idle status after an in-flight running status', async () => {
    let releaseRunning: () => void = () => {}
    const runningPending = new Promise<void>(resolve => {
      releaseRunning = resolve
    })
    const delivered: string[] = []
    const uploader = new WorkerStateUploader({
      send: async body => {
        if (body.worker_status === 'running') await runningPending
        delivered.push(body.worker_status as string)
        return true
      },
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitterMs: 0,
    })

    uploader.enqueue({ worker_status: 'running' })
    uploader.enqueue({ worker_status: 'idle' })
    const flushed = uploader.flush()
    releaseRunning()
    await flushed
    uploader.close()

    expect(delivered).toEqual(['running', 'idle'])
  })

  test('close still abandons pending status after a bounded flush timeout', async () => {
    let releaseRunning: () => void = () => {}
    const runningPending = new Promise<void>(resolve => {
      releaseRunning = resolve
    })
    const delivered: string[] = []
    const uploader = new WorkerStateUploader({
      send: async body => {
        await runningPending
        delivered.push(body.worker_status as string)
        return true
      },
      baseDelayMs: 1,
      maxDelayMs: 1,
      jitterMs: 0,
    })

    uploader.enqueue({ worker_status: 'running' })
    uploader.enqueue({ worker_status: 'idle' })
    const flushed = uploader.flush()
    uploader.close()
    releaseRunning()
    await flushed

    expect(delivered).toEqual(['running'])
  })
})

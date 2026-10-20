import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

test('Responses transport checks run with isolated auth and timers', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      'test',
      resolve(__dirname, 'responsesTransport.runner.ts'),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
  expect(code).toBe(0)
}, 60_000)

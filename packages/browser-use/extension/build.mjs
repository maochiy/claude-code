import { cp, mkdir, rm } from 'node:fs/promises'

const root = new URL('.', import.meta.url).pathname
const dist = root + 'dist/'
await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
for (const file of [
  'manifest.json',
  'service-worker.js',
  'cdp.js',
  'sidepanel.html',
  'sidepanel.js',
  'sidepanel.css',
]) {
  await cp(root + 'src/' + file, dist + file)
}
console.log('built dist')

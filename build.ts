import { readdir, readFile, writeFile, cp } from 'fs/promises'
import { join } from 'path'
import { getMacroDefines } from './scripts/defines.ts'
import { DEFAULT_BUILD_FEATURES } from './scripts/defines.ts'

const outdir = 'dist'

// Step 1: Clean output directory
const { rmSync } = await import('fs')
rmSync(outdir, { recursive: true, force: true })

// Collect FEATURE_* env vars → Bun.build features
const envFeatures = Object.keys(process.env)
  .filter(k => k.startsWith('FEATURE_'))
  .map(k => k.replace('FEATURE_', ''))
const features = [...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])]

// gaxios still imports node-fetch for runtimes without a native Fetch API.
// Both supported launchers (Bun and modern Node.js) provide fetch globally,
// so bundle a small adapter instead of leaving two incompatible node-fetch
// major versions as unresolved production imports.
// Step 2: Bundle with splitting
const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir,
  target: 'bun',
  splitting: true,
  sourcemap: 'linked',
  // Keep the native keyring loader external so package installation or the
  // desktop packager can provide the correct platform addon. Bundling it on
  // one host permanently compiles all other platform branches into throws.
  external: ['@napi-rs/keyring'],
  define: {
    ...getMacroDefines(),
    // React production mode — eliminates _debugStack Error objects
    // (6,889 objects × ~1.7KB = 12MB in development builds) and removes
    // prop-type / key warnings not useful in a production CLI tool.
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  features,
})

if (!result.success) {
  console.error('Build failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

// Step 3: Post-process — replace Bun-only `import.meta.require` with Node.js compatible version
const files = await readdir(outdir)
const IMPORT_META_REQUIRE = 'var __require = import.meta.require;'
const COMPAT_REQUIRE = `var __require = typeof import.meta.require === "function" ? import.meta.require : (await import("module")).createRequire(import.meta.url);`

let patched = 0
for (const file of files) {
  if (!file.endsWith('.js')) continue
  const filePath = join(outdir, file)
  const content = await readFile(filePath, 'utf-8')
  if (content.includes(IMPORT_META_REQUIRE)) {
    await writeFile(
      filePath,
      content.replace(IMPORT_META_REQUIRE, COMPAT_REQUIRE),
    )
    patched++
  }
}

// gaxios v6/v7 retain node-fetch fallbacks even though supported Bun and
// Node.js runtimes provide the standard Fetch API. Bun cannot bundle the two
// incompatible transitive node-fetch major versions under code splitting, so
// replace only their known default-import forms with the native implementation.
// The bundle integrity check remains authoritative: any new import shape is
// left untouched and fails the build instead of being silently ignored.
const NODE_FETCH_REQUIRE = '__importDefault(__require("node-fetch"))'
const NODE_FETCH_IMPORT = 'import("node-fetch")'
let nativeFetchPatched = 0
for (const file of files) {
  if (!file.endsWith('.js')) continue
  const filePath = join(outdir, file)
  const content = await readFile(filePath, 'utf-8')
  const requireCount = content.split(NODE_FETCH_REQUIRE).length - 1
  const importCount = content.split(NODE_FETCH_IMPORT).length - 1
  if (requireCount === 0 && importCount === 0) continue
  const next = content
    .replaceAll(NODE_FETCH_REQUIRE, '{ default: globalThis.fetch }')
    .replaceAll(
      NODE_FETCH_IMPORT,
      'Promise.resolve({ default: globalThis.fetch })',
    )
  await writeFile(filePath, next)
  nativeFetchPatched += requireCount + importCount
}

// Also patch unguarded globalThis.Bun destructuring from third-party deps
// (e.g. @anthropic-ai/sandbox-runtime) so Node.js doesn't crash at import time.
let bunPatched = 0
const BUN_DESTRUCTURE = /var \{([^}]+)\} = globalThis\.Bun;?/g
const BUN_DESTRUCTURE_SAFE =
  'var {$1} = typeof globalThis.Bun !== "undefined" ? globalThis.Bun : {};'
for (const file of files) {
  if (!file.endsWith('.js')) continue
  const filePath = join(outdir, file)
  const content = await readFile(filePath, 'utf-8')
  if (BUN_DESTRUCTURE.test(content)) {
    await writeFile(
      filePath,
      content.replace(BUN_DESTRUCTURE, BUN_DESTRUCTURE_SAFE),
    )
    bunPatched++
  }
}
BUN_DESTRUCTURE.lastIndex = 0

console.log(
  `Bundled ${result.outputs.length} files to ${outdir}/ (patched ${patched} for import.meta.require, ${nativeFetchPatched} for native fetch, ${bunPatched} for Bun destructure)`,
)

// Step 4: Copy native .node addon files (audio-capture) and vendored binaries (ripgrep)
const audioCaptureDir = join(outdir, 'vendor', 'audio-capture')
await cp('vendor/audio-capture', audioCaptureDir, { recursive: true })
console.log(`Copied vendor/audio-capture/ → ${audioCaptureDir}/`)

const ripgrepDir = join(outdir, 'vendor', 'ripgrep')
await cp('src/utils/vendor/ripgrep', ripgrepDir, { recursive: true })
console.log(`Copied src/utils/vendor/ripgrep/ → ${ripgrepDir}/`)

// 从源码构建浏览器扩展，干净 checkout 不能依赖之前生成的 dist。
const extensionBuild = Bun.spawnSync(
  [process.execPath, 'packages/browser-use/extension/build.mjs'],
  { stdout: 'inherit', stderr: 'inherit' },
)
if (extensionBuild.exitCode !== 0)
  throw new Error('Browser extension build failed')
const extensionDir = join(outdir, 'extension')
await cp('packages/browser-use/extension/dist', extensionDir, {
  recursive: true,
})
console.log(`Copied packages/browser-use/extension/dist/ → ${extensionDir}/`)

// Step 5: Generate cli-bun and cli-node executable entry points
const cliBun = join(outdir, 'cli-bun.js')
const cliNode = join(outdir, 'cli-node.js')

await writeFile(cliBun, '#!/usr/bin/env bun\nimport "./cli.js"\n')

await writeFile(cliNode, '#!/usr/bin/env node\nimport "./cli.js"\n')

// Make both executable
const { chmodSync } = await import('fs')
chmodSync(cliBun, 0o755)
chmodSync(cliNode, 0o755)

console.log(`Generated ${cliBun} (shebang: bun) and ${cliNode} (shebang: node)`)

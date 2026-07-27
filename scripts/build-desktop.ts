import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { getMacroDefines, DEFAULT_BUILD_FEATURES } from './defines.js'
import type {
  DesktopCapabilityManifest,
  RuntimeCapabilitySet,
} from '../src/desktop/protocol/types.js'
import { assertCapabilityParity } from '../src/desktop/capabilities/manifest.js'
import { DESKTOP_PROTOCOL_JSON_SCHEMA } from '../src/desktop/protocol/schema.js'

const outdir = 'dist-desktop'
const desktopBuildFeatures = DEFAULT_BUILD_FEATURES.filter(
  feature => feature !== 'ACP',
)
const runtimePackage = JSON.parse(await readFile('package.json', 'utf8')) as {
  version: string
}
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

const result = await Bun.build({
  entrypoints: ['src/desktop/entry.ts', 'src/desktop/session-worker.ts'],
  outdir,
  target: 'node',
  splitting: true,
  sourcemap: 'linked',
  naming: {
    entry: '[dir]/[name].js',
    chunk: 'chunks/[name]-[hash].js',
  },
  define: {
    ...getMacroDefines(),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  features: desktopBuildFeatures,
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

await cp('vendor/audio-capture', join(outdir, 'native', 'audio-capture'), {
  recursive: true,
})
await cp('src/utils/vendor/ripgrep', join(outdir, 'native', 'ripgrep'), {
  recursive: true,
})
await writeFile(
  join(outdir, 'protocol.schema.json'),
  JSON.stringify(DESKTOP_PROTOCOL_JSON_SCHEMA, null, 2),
)

for (const entrypoint of ['entry.js', 'session-worker.js']) {
  await chmod(join(outdir, entrypoint), 0o755)
}

async function buildCapabilityProbe(
  buildFeatureFlags: readonly string[],
): Promise<RuntimeCapabilitySet> {
  const probeDir = await mkdtemp(join(tmpdir(), 'ccb-desktop-capability-'))
  try {
    const probeResult = await Bun.build({
      entrypoints: ['src/desktop/capabilities/buildProbe.ts'],
      outdir: probeDir,
      target: 'bun',
      splitting: false,
      sourcemap: 'none',
      define: {
        ...getMacroDefines(),
        'process.env.NODE_ENV': JSON.stringify('production'),
      },
      features: buildFeatureFlags,
    })
    if (!probeResult.success) {
      for (const log of probeResult.logs) console.error(log)
      throw new Error('Capability Probe 构建失败')
    }
    const output = probeResult.outputs.find(item =>
      item.path.endsWith('buildProbe.js'),
    )
    if (!output) throw new Error('Capability Probe 输出缺失')
    const probeModule = (await import(
      `${pathToFileURL(output.path).href}?build=${Date.now()}`
    )) as {
      createBuildCapabilitySet(
        featureFlags: readonly string[],
      ): RuntimeCapabilitySet
    }
    return probeModule.createBuildCapabilitySet(buildFeatureFlags)
  } finally {
    await rm(probeDir, { recursive: true, force: true })
  }
}

const capabilityManifest: DesktopCapabilityManifest = {
  manifestVersion: 1,
  generatedFrom: 'shared-core-registries',
  cliCore: await buildCapabilityProbe(DEFAULT_BUILD_FEATURES),
  desktopRuntime: await buildCapabilityProbe(desktopBuildFeatures),
  transportExclusions: [
    {
      capability: 'ACP',
      reason:
        'Desktop 使用原生双 MessagePort Runtime Protocol，不启用 ACP Transport',
    },
  ],
}
assertCapabilityParity(capabilityManifest)
const capabilitiesJson = JSON.stringify(capabilityManifest)
await writeFile(
  join(outdir, 'capability-manifest.json'),
  JSON.stringify(capabilityManifest, null, 2),
)
await writeFile(
  join(outdir, 'THIRD_PARTY_LICENSES.txt'),
  [
    'Claude Code Best Desktop Runtime third-party notices',
    '',
    'This artifact contains dependencies declared by claude-code-best/package.json.',
    'Their license texts and package metadata are preserved in the source distribution.',
    'Run the repository license audit in release CI before publishing an artifact.',
    '',
  ].join('\n'),
)

async function collectFiles(
  dir: string,
): Promise<Array<{ path: string; sha256: string; executable?: boolean }>> {
  const collected: Array<{
    path: string
    sha256: string
    executable?: boolean
  }> = []
  for (const name of await readdir(dir)) {
    const fullPath = join(dir, name)
    const info = await stat(fullPath)
    if (info.isDirectory()) {
      collected.push(...(await collectFiles(fullPath)))
      continue
    }
    const path = relative(outdir, fullPath)
    if (path === 'runtime-manifest.json') continue
    const bytes = await readFile(fullPath)
    collected.push({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(path === 'entry.js' || path === 'session-worker.js'
        ? { executable: true }
        : {}),
    })
  }
  return collected
}

const files = await collectFiles(outdir)
await writeFile(
  join(outdir, 'runtime-manifest.json'),
  JSON.stringify(
    {
      runtimeName: 'claude-code-best',
      runtimeVersion: process.env.CLAUDE_CODE_VERSION ?? runtimePackage.version,
      gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      protocolVersion: 1,
      platform: process.platform,
      arch: process.arch,
      buildTime: new Date().toISOString(),
      entrypoints: { host: 'entry.js', worker: 'session-worker.js' },
      capabilitiesHash: createHash('sha256')
        .update(capabilitiesJson)
        .digest('hex'),
      files,
    },
    null,
    2,
  ),
)
console.log(`Desktop Runtime 已构建到 ${outdir}/`)

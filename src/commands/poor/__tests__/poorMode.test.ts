/**
 * Tests for fix: 修复穷鬼模式的写入问题
 *
 * Before the fix, poorMode was an in-memory boolean that reset on restart.
 * After the fix, it reads from / writes to settings.json via
 * getInitialSettings() and updateSettingsForSource().
 */
import { afterAll, describe, expect, test, beforeEach, mock } from 'bun:test'
import { flagAwareModule } from '../../../../tests/mocks/flagAwareModule.js'
// Snapshot the REAL settings module before mock.module registers (bun
// retroactively patches live bindings of already-imported modules, so a bare
// `import * as settingsModule` reflects later mocks). After this file's
// afterAll, later test files in the same process (configuredModels.test.ts, …)
// must see the real settings implementation — restoring from the snapshot
// keeps them working. Restoring from the namespace object itself would re-
// register this file's mock (the live bindings are retroactively patched).
import * as realSettingsModule from '../../../utils/settings/settings.js'

const realSettingsSnapshot: Record<string, unknown> = {
  ...(realSettingsModule as unknown as Record<string, unknown>),
}

// ── Mocks must be declared before the module under test is imported ──────────

let useMockForPoorMode = true
let mockSettings: Record<string, unknown> = {}
let lastUpdate: { source: string; patch: Record<string, unknown> } | null = null

const poorModeSettingsMockSurface: Record<string, unknown> = {
  loadManagedFileSettings: () => ({ settings: null, errors: [] }),
  getManagedFileSettingsPresence: () => ({
    hasBase: false,
    hasDropIns: false,
  }),
  parseSettingsFile: () => ({ settings: null, errors: [] }),
  getSettingsRootPathForSource: () => '',
  getSettingsFilePathForSource: () => undefined,
  getRelativeSettingsFilePathForSource: () => '',
  getInitialSettings: () => mockSettings,
  getSettingsForSource: () => mockSettings,
  getPolicySettingsOrigin: () => null,
  getSettingsWithErrors: () => ({ settings: mockSettings, errors: [] }),
  getSettingsWithSources: () => ({ effective: mockSettings, sources: [] }),
  getSettings_DEPRECATED: () => mockSettings,
  settingsMergeCustomizer: () => undefined,
  getManagedSettingsKeysForLogging: () => [],
  // Keep unrelated exports aligned with the real settings module so this
  // full-surface mock cannot change later test files if Bun keeps it alive.
  hasAutoModeOptIn: () => true,
  hasSkipDangerousModePermissionPrompt: () => false,
  getAutoModeConfig: () => undefined,
  getUseAutoModeDuringPlan: () => true,
  rawSettingsContainsKey: (key: string) => key in mockSettings,
  updateSettingsForSource: (source: string, patch: Record<string, unknown>) => {
    lastUpdate = { source, patch }
    mockSettings = { ...mockSettings, ...patch }
  },
}

// flagAwareModule serves each export as a call-time-branching wrapper: while
// useMockForPoorMode is true the mock surface wins, afterwards the real
// snapshot's implementations are served (fills every real export name this
// mock-surface doesn't declare — a bare mock would SyntaxError later files
// that import the missing names).
mock.module('src/utils/settings/settings.js', () =>
  flagAwareModule(
    poorModeSettingsMockSurface,
    realSettingsSnapshot,
    () => useMockForPoorMode,
  ),
)

afterAll(() => {
  // Flip the call-time branch instead of re-registering the namespace object:
  // `mock.restore()` does not unregister bun mocks, and the imported
  // `settingsModule` live bindings are retroactively patched by this file's
  // own mock — re-registering it would serve the mock to later files.
  useMockForPoorMode = false
})

// Import AFTER mocks are registered. The query suffix gives this file its own
// module instance so cross-file poorMode.js mocks cannot replace the subject
// under test during Bun's shared coverage run.
const poorModeModulePath = '../poorMode.js?poorModeTest'
const { isPoorModeActive, setPoorMode } = (await import(
  poorModeModulePath
)) as typeof import('../poorMode.js')

// ── Tests ────────────────────────────────────────────────────────────────────

describe('isPoorModeActive — reads from settings on first call', () => {
  beforeEach(() => {
    lastUpdate = null
  })

  test('returns false when settings has no poorMode key', () => {
    mockSettings = {}
    // Force re-read by setting internal state via setPoorMode then checking
    setPoorMode(false)
    expect(isPoorModeActive()).toBe(false)
  })

  test('returns true when settings.poorMode === true', () => {
    mockSettings = { poorMode: true }
    setPoorMode(true)
    expect(isPoorModeActive()).toBe(true)
  })
})

describe('setPoorMode — persists to settings', () => {
  beforeEach(() => {
    lastUpdate = null
  })

  test('setPoorMode(true) calls updateSettingsForSource with poorMode: true', () => {
    setPoorMode(true)
    expect(lastUpdate).not.toBeNull()
    expect(lastUpdate!.source).toBe('userSettings')
    expect(lastUpdate!.patch.poorMode).toBe(true)
  })

  test('setPoorMode(false) calls updateSettingsForSource with poorMode: undefined (removes key)', () => {
    setPoorMode(false)
    expect(lastUpdate).not.toBeNull()
    expect(lastUpdate!.source).toBe('userSettings')
    // false || undefined === undefined — key should be removed to keep settings clean
    expect(lastUpdate!.patch.poorMode).toBeUndefined()
  })

  test('isPoorModeActive() reflects the value set by setPoorMode()', () => {
    setPoorMode(true)
    expect(isPoorModeActive()).toBe(true)

    setPoorMode(false)
    expect(isPoorModeActive()).toBe(false)
  })

  test('toggling multiple times stays consistent', () => {
    setPoorMode(true)
    setPoorMode(true)
    expect(isPoorModeActive()).toBe(true)

    setPoorMode(false)
    setPoorMode(false)
    expect(isPoorModeActive()).toBe(false)
  })
})

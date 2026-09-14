/**
 * Central bun:test preload (registered in bunfig.toml [test] preload).
 *
 * MACRO is a build-time define injected via `bun --define` (see
 * scripts/defines.ts → getMacroDefines). In bun:test no defines are
 * injected, so bare `MACRO` identifiers in source resolve to
 * `ReferenceError: MACRO is not defined` — most visibly the fire-and-forget
 * `logAPIQuery` block in queryModel (src/services/api/claude.ts:1839-1841),
 * whose `void … .then()` unhandled rejection fails whichever test happens
 * to be running when the haiku observer chain fires (H7 circuit breaker,
 * projectContext, …). Setting the full define map on globalThis lets every
 * bare `MACRO` reference resolve at runtime across all test files, instead
 * of each test file re-declaring its own defensive copy (the pattern from
 * pathValidation.test.ts, centralized here).
 */
import { getMacroDefines } from '../scripts/defines.ts'

const defines = getMacroDefines()
const macro: Record<string, unknown> = {}
for (const [key, value] of Object.entries(defines)) {
  // Keys look like 'MACRO.VERSION' — strip the namespace for the
  // globalThis property the bare identifier resolves to.
  macro[key.replace('MACRO.', '')] = JSON.parse(value) as unknown
}
;(globalThis as unknown as { MACRO: Record<string, unknown> }).MACRO = macro

/**
 * Build a mock.module() factory result that serves a suite-specific mock
 * surface while a flag is active, and falls through to the REAL module's
 * exports once the flag flips off (typically in afterAll).
 *
 * Why this exists: bun's mock.module is process-global (last-write-wins), so
 * once a test file registers a mock for a specifier, every test file that
 * loads afterwards in the same bun process resolves that specifier to the
 * mock. Partial mock surfaces also break later importers outright
 * (SyntaxError: Export named 'X' not found). Flag-aware delegation keeps the
 * suite's own behavior unchanged while making the mock harmless — identical
 * to the real module — for every later file.
 *
 * Usage pattern (inside a *.test.ts):
 *
 *   import * as realFooModule from 'src/utils/foo.js'
 *   // Snapshot BEFORE mock.module registers: bun retroactively patches live
 *   // bindings of already-imported modules, so the namespace object itself
 *   // must be copied into a plain object immediately.
 *   const realFooSnapshot = { ...realFooModule } as Record<string, unknown>
 *   let useMock = true
 *   afterAll(() => { useMock = false })
 *   mock.module('src/utils/foo.js', () =>
 *     flagAwareModule(mockSurface, realFooSnapshot, () => useMock),
 *   )
 *
 * The factory may be evaluated eagerly or lazily by bun; the returned
 * wrappers re-check the flag on every call, so both timings are safe.
 * Value-typed (non-function) exports cannot branch per property access and
 * always prefer the real value.
 */
export function flagAwareModule(
  mockSurface: Record<string, unknown>,
  realModule: Record<string, unknown>,
  useMock: () => boolean,
): Record<string, unknown> {
  const names = new Set([
    ...Object.keys(mockSurface),
    ...Object.keys(realModule),
  ])
  const out: Record<string, unknown> = {}
  for (const name of names) {
    const mockValue = mockSurface[name]
    const realValue = realModule[name]
    if (typeof mockValue !== 'function' && typeof realValue !== 'function') {
      out[name] = realValue ?? mockValue
      continue
    }
    // PLAIN function expression (not an arrow): bun/JSC checks the Proxy
    // TARGET's construct-ness directly for `new proxy()` and bypasses the
    // construct trap over a non-constructor target (TypeError: function is
    // not a constructor). Plain functions ARE constructors in JSC, so both
    // `new proxy()` (construct trap called) and normal calls work.
    const branch = function (this: unknown, ...args: unknown[]) {
      if (useMock() && mockValue !== undefined) {
        return typeof mockValue === 'function' ? mockValue(...args) : mockValue
      }
      return typeof realValue === 'function' ? realValue(...args) : realValue
    }
    // Wrap in a Proxy so classes survive: a bare arrow wrapper would lose
    // constructor-ness and `new Ink()` in later files would throw
    // TypeError: function is not a constructor.
    out[name] = new Proxy(branch, {
      construct(_target, args) {
        if (useMock() && mockValue !== undefined) {
          return Reflect.construct(
            mockValue as (...args: unknown[]) => unknown,
            args,
          )
        }
        return Reflect.construct(
          realValue as (...args: unknown[]) => unknown,
          args,
        )
      },
      get(_target, prop, receiver) {
        // Delegate property reads to the branch-selected value so class
        // statics/prototype stay reachable (e.g. `Ink.someStatic`).
        const selected =
          useMock() && mockValue !== undefined ? mockValue : realValue
        const value =
          typeof selected === 'function' ||
          (typeof selected === 'object' && selected !== null)
            ? selected
            : branch
        const result = Reflect.get(value as object, prop, receiver)
        return typeof result === 'function' ? result.bind(selected) : result
      },
    })
  }
  return out
}

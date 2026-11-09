import { describe, expect, test } from 'bun:test'

// Execute the production slice/memo boundary without importing the REPL's
// network/bootstrap dependency tree or installing process-global module mocks.
const root = new URL('../../', import.meta.url)
const repl = await Bun.file(new URL('screens/REPL.tsx', root)).text()
const messagesSource = await Bun.file(
  new URL('components/Messages.tsx', root),
).text()
const transpiler = new Bun.Transpiler({ loader: 'tsx' })
const comparatorSource = messagesSource.slice(
  messagesSource.indexOf('function setsEqual'),
  messagesSource.indexOf('export function shouldRenderStatically'),
)
const compare = new Function(
  'React',
  'const MessagesImpl = () => null;\n' +
    transpiler.transformSync(
      comparatorSource.replace('export const Messages', 'const Messages'),
    ) +
    '\nreturn Messages;',
)({ memo: (_component: unknown, comparator: unknown) => comparator }) as (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
) => boolean

// Minimal dependency-slot harness for the production useMemo expressions.
// This tests invalidation decisions, not Ink rendering or terminal latency.
function createSlices() {
  const start = repl.indexOf('  const frozenMessagesLength =')
  const end = repl.indexOf('  // Handle shift+down', start)
  const body = repl.slice(start, end)
  const slots: { deps: unknown[]; value: unknown }[] = []
  let index = 0
  const useMemo = (factory: () => unknown, deps: unknown[]) => {
    const i = index++
    const previous = slots[i]
    if (previous && deps.every((dep, j) => Object.is(dep, previous.deps[j])))
      return previous.value
    const value = factory()
    slots[i] = { deps, value }
    return value
  }
  const run = new Function(
    'useMemo',
    'deferredMessages',
    'streamingToolUses',
    'frozenTranscriptState',
    transpiler.transformSync(body) +
      '\nreturn { transcriptMessages, transcriptStreamingToolUses };',
  )
  return (history: unknown[], streaming: unknown[], frozen: unknown) => {
    index = 0
    return run(useMemo, history, streaming, frozen) as {
      transcriptMessages: unknown[]
      transcriptStreamingToolUses: unknown[]
    }
  }
}

const stableQueue = {}
function props(history: unknown[], queue: unknown = stableQueue) {
  return { messages: history, toolUseConfirmQueue: queue }
}

function historyWorkCount(
  makeProps: () => Record<string, unknown>,
  updates = 40,
) {
  let previous = makeProps()
  let previousHistory = previous.messages
  let renders = 0
  let historyPasses = 0
  for (let i = 0; i < updates; i++) {
    const next = makeProps()
    if (!compare(previous, next)) {
      renders++
      if (next.messages !== previousHistory) historyPasses++
      previousHistory = next.messages
    }
    previous = next
  }
  return { renders, historyPasses }
}

describe('message history memo boundary', () => {
  test('composing while scrolled away does not repin the message viewport', () => {
    const inputUpdate = repl.slice(
      repl.indexOf('  const setInputValue = useCallback('),
      repl.indexOf(
        '  // Schedule a timeout to stop suppressing dialogs',
        repl.indexOf('  const setInputValue = useCallback('),
      ),
    )
    expect(inputUpdate).not.toContain('repinScroll()')
    expect(repl).toContain('if (lastMsgIsHuman) {\n      repinScroll()')
  })
  test('cancelling an active turn notifies bridge clients that it ended', () => {
    const cancel = repl.slice(
      repl.indexOf('  function onCancel() {'),
      repl.indexOf(
        '  // Function to handle queued command when canceling a permission request',
      ),
    )
    expect(cancel).toContain('queryGuard.forceEnd()')
    expect(cancel).toContain('sendBridgeResultRef.current()')
  })

  test('unchanged main-screen history already skips work on input-only updates', () => {
    const history = Array.from({ length: 27000 }, (_, i) => ({ uuid: `${i}` }))
    expect(historyWorkCount(() => props(history))).toEqual({
      renders: 0,
      historyPasses: 0,
    })
  })

  test('frozen slices and empty queue no longer invalidate history on every update', () => {
    const history = Array.from({ length: 27000 }, (_, i) => ({ uuid: `${i}` }))
    const before = historyWorkCount(() =>
      props(history.slice(0, history.length), []),
    )
    const slices = createSlices()
    const streaming: unknown[] = []
    const frozen = {
      messagesLength: history.length,
      streamingToolUsesLength: 0,
    }
    const after = historyWorkCount(() =>
      props(slices(history, streaming, frozen).transcriptMessages),
    )
    expect(before).toEqual({ renders: 40, historyPasses: 40 })
    expect(after).toEqual({ renders: 0, historyPasses: 0 })
    expect(repl).toContain('toolUseConfirmQueue={EMPTY_TOOL_USE_CONFIRM_QUEUE}')
    console.info('27000 messages / 40 input-only updates:', { before, after })
  })

  test('freezing keeps earliest history and invalidates when source or frozen length changes', () => {
    const history = Array.from({ length: 1000 }, (_, i) => ({ uuid: `${i}` }))
    const slices = createSlices()
    const streaming = [{ id: 'one' }, { id: 'two' }]
    const frozen = { messagesLength: 900, streamingToolUsesLength: 1 }
    const first = slices(history, streaming, frozen)
    expect(first.transcriptMessages).toHaveLength(900)
    expect(first.transcriptMessages[0]).toBe(history[0])
    expect(slices(history, streaming, { ...frozen }).transcriptMessages).toBe(
      first.transcriptMessages,
    )
    const changed = slices([...history], streaming, frozen)
    expect(changed.transcriptMessages).not.toBe(first.transcriptMessages)
    expect(
      slices(history, streaming, { ...frozen, messagesLength: 950 })
        .transcriptMessages,
    ).toHaveLength(950)
    expect(
      slices(history, streaming, { ...frozen, streamingToolUsesLength: 2 })
        .transcriptStreamingToolUses,
    ).toHaveLength(2)
    expect(slices(history, streaming, null).transcriptMessages).toBe(history)
    expect(repl).toContain(
      'const deferredMessages = useDeferredValue(messages)',
    )
    expect(repl).not.toContain('const DEFERRED_CAP =')
  })
})

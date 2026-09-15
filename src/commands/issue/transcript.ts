/**
 * Pure transcript reading helpers for the /issue command.
 *
 * Kept free of fs / bootstrap-state / child_process imports so the parsing
 * logic is unit-testable without mocking the session store.
 */

/** Truncation length applied to each snippet in the generated issue body. */
const SNIPPET_CHARS = 200

/** How many error snippets to append under the "### Recent errors" heading. */
const MAX_ERROR_SNIPPETS = 3

interface EntryFields {
  role: string | undefined
  content: unknown
}

/**
 * Session log lines are JSONL records written by sessionStorage. Conversation
 * content lives one level down, under `message`:
 *
 *   { "type": "assistant", "message": { "role": "assistant", "content": [...] } }
 *
 * Some writers instead put `role`/`content` at the top level, so both shapes
 * are accepted rather than assuming one.
 */
function readEntryFields(entry: Record<string, unknown>): EntryFields {
  const raw = entry.message
  const source =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : entry
  return {
    role: typeof source.role === 'string' ? source.role : undefined,
    content: source.content,
  }
}

/**
 * Flatten a tool_result `content` payload to plain text. It is either a bare
 * string or an array of content blocks.
 */
function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (!block || typeof block !== 'object') return ''
      const b = block as Record<string, unknown>
      return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

/**
 * Summarize raw JSONL session lines into a markdown-ready block: the last
 * `maxTurns` user/assistant turns (one line each, truncated) followed by up to
 * three recent tool errors.
 */
export function summarizeTranscript(lines: string[], maxTurns = 5): string {
  const turns: string[] = []
  const errors: string[] = []

  for (const line of lines) {
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    const { role, content } = readEntryFields(entry)

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Record<string, unknown>
        if (b.type !== 'tool_result' || b.is_error !== true) continue
        const text = flattenToolResult(b.content)
        if (text) errors.push(text.slice(0, SNIPPET_CHARS))
      }
    }

    if (role !== 'user' && role !== 'assistant') continue

    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      const firstText = content.find(
        block =>
          !!block &&
          typeof block === 'object' &&
          (block as Record<string, unknown>).type === 'text',
      ) as Record<string, unknown> | undefined
      if (typeof firstText?.text === 'string') text = firstText.text
    }
    if (text) turns.push(`[${role}] ${text.slice(0, SNIPPET_CHARS)}`)
  }

  // user + assistant per turn
  const recent = turns.slice(-maxTurns * 2)
  let result =
    recent.length > 0 ? recent.join('\n') : '(no conversation content in log)'

  if (errors.length > 0) {
    result +=
      '\n\n### Recent errors\n' + errors.slice(-MAX_ERROR_SNIPPETS).join('\n')
  }
  return result
}

const SYSTEM_ENVIRONMENT_KEYS = new Set([
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'SHELL',
  'TMP',
  'TEMP',
  'TMPDIR',
  'LANG',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
  'TERM',
  'COLORTERM',
])

const SAFE_PREFIXES = [
  'LC_',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]

export function buildDesktopWorkerEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (
      SYSTEM_ENVIRONMENT_KEYS.has(name) ||
      SAFE_PREFIXES.some(prefix => name === prefix || name.startsWith(prefix))
    ) {
      result[name] = value
    }
  }
  result.CLAUDE_CODE_ENTRYPOINT = 'desktop-runtime'
  return result
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-ant-[A-Za-z0-9_-]{12,})\b/g,
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(Bearer\s+)[^\s"',;]+/gi,
  /((?:api[_-]?key|auth[_-]?token|access[_-]?token|authorization)\s*[:=]\s*)[^\s"',;]+/gi,
  /((?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_CUSTOM_HEADERS)\s*[:=]\s*)[^\s"',;]+/gi,
  /((?:OPENAI_CHATGPT_(?:ACCESS|REFRESH)_TOKEN)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
]

export function redactRuntimeSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) =>
      redacted.replace(pattern, (_match, prefix?: string) =>
        prefix ? `${prefix}[REDACTED]` : '[REDACTED]',
      ),
    value,
  )
}

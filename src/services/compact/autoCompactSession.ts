let sessionAutoCompactOverride: boolean | undefined

export function setSessionAutoCompactOverride(
  enabled: boolean | undefined,
): void {
  sessionAutoCompactOverride = enabled
}

export function getSessionAutoCompactOverride(): boolean | undefined {
  return sessionAutoCompactOverride
}

export function resolveSessionAutoCompactEnabled(
  configured: boolean,
  disabledByEnvironment: boolean,
): boolean {
  if (disabledByEnvironment) return false
  return sessionAutoCompactOverride ?? configured
}

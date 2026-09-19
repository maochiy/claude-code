const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const

/** 应用代理覆盖所有 CLI 入口；未启用时保留调用方及进程已有配置。 */
export function buildLocalCliProxyEnvironment(
  input: Record<string, string | undefined>,
  proxyUrl: string | undefined,
  inherited: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of [...PROXY_KEYS, 'NO_PROXY']) {
    const value = input[key] ?? input[key.toLowerCase()] ?? inherited[key] ?? inherited[key.toLowerCase()]
    if (value !== undefined) {
      result[key] = value
      result[key.toLowerCase()] = value
    }
  }
  if (proxyUrl?.trim()) {
    for (const key of PROXY_KEYS) {
      result[key] = proxyUrl.trim()
      result[key.toLowerCase()] = proxyUrl.trim()
    }
  }
  // 会话 MCP endpoint 和本地 Provider 不应把本机鉴权信息转交给外部代理。
  const exclusions = new Set((result.NO_PROXY ?? '').split(',').map(value => value.trim()).filter(Boolean))
  for (const address of ['localhost', '127.0.0.1', '::1']) exclusions.add(address)
  result.NO_PROXY = [...exclusions].join(',')
  result.no_proxy = result.NO_PROXY
  return result
}

export interface LocalServiceHealth {
  protocolVersion: number
  serviceVersion: string
  capabilities?: string[]
}

/** 未通过握手的服务不接收任何会话或执行请求。 */
export function validateLocalServiceHealth(value: Record<string, unknown>): LocalServiceHealth {
  if (value.protocolVersion !== 1) throw new Error('本地服务协议不兼容')
  if (typeof value.serviceVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(value.serviceVersion)) {
    throw new Error('本地服务没有提供有效版本')
  }
  if (value.shuttingDown !== false) throw new Error('本地服务正在退出，无法建立执行会话')
  if (value.capabilities !== undefined && (!Array.isArray(value.capabilities)
    || !value.capabilities.every(capability => typeof capability === 'string'))) {
    throw new Error('本地服务能力握手无效')
  }
  return { protocolVersion: 1, serviceVersion: value.serviceVersion,
    ...(Array.isArray(value.capabilities) ? { capabilities: value.capabilities as string[] } : {}) }
}

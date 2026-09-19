import { describe, expect, test } from 'bun:test'
import { validateLocalServiceHealth } from './handshake'

describe('本地服务启动握手', () => {
  const healthy = { protocolVersion: 1, serviceVersion: '0.1.0', shuttingDown: false }
  test('启动后确认协议和版本', () => {
    expect(validateLocalServiceHealth(healthy)).toEqual({ protocolVersion: 1, serviceVersion: '0.1.0' })
  })
  test('协议不兼容、版本缺失或退出中的服务不能接收会话', () => {
    expect(() => validateLocalServiceHealth({ ...healthy, protocolVersion: 2 })).toThrow('协议不兼容')
    expect(() => validateLocalServiceHealth({ ...healthy, serviceVersion: undefined })).toThrow('有效版本')
    expect(() => validateLocalServiceHealth({ ...healthy, shuttingDown: true })).toThrow('正在退出')
    expect(() => validateLocalServiceHealth({ ...healthy, capabilities: [1] })).toThrow('能力握手无效')
  })
})

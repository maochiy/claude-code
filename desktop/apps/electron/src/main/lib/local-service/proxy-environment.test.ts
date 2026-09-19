import { describe, expect, test } from 'bun:test'
import { buildLocalCliProxyEnvironment } from './proxy-environment'

describe('所有 Local CLI 入口的代理环境', () => {
  test('Given 应用手动代理 When Chat 或辅助 CLI 创建 Then 覆盖大小写代理并保留 NO_PROXY', () => {
    const result = buildLocalCliProxyEnvironment({ HTTPS_PROXY: 'http://old:80' }, ' http://localhost:8080 ', { no_proxy: 'localhost,127.0.0.1' })
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
      expect(result[key]).toBe('http://localhost:8080')
      expect(result[key.toLowerCase()]).toBe('http://localhost:8080')
    }
    expect(result.NO_PROXY).toBe('localhost,127.0.0.1,::1')
    expect(result.no_proxy).toBe(result.NO_PROXY)
  })
  test('Given 系统检测不可用 When 创建 CLI Then 不凭空生成代理并保留显式环境优先级', () => {
    expect(buildLocalCliProxyEnvironment({}, undefined, {})).toEqual({ NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' })
    const result = buildLocalCliProxyEnvironment({ http_proxy: 'http://explicit:80', NO_PROXY: '' }, undefined, { HTTP_PROXY: 'http://parent:80', NO_PROXY: '*' })
    expect(result.HTTP_PROXY).toBe('http://explicit:80')
    expect(result.NO_PROXY).toBe('localhost,127.0.0.1,::1')
  })
})

import { describe, expect, test } from 'bun:test'
import { builtinMcpToolFactory } from '../builtin-mcp/tool-definition'
import { createLazyBuiltinMcpServerDefinition } from '../builtin-mcp/lazy-definition'
import { materializeLocalCliMcpServers } from './mcp-transport'

describe('Local CLI MCP 传输边界', () => {
  test('Given 惰性浏览器工具与外部 MCP When 准备 CLI Then 初始化定义并仅传序列化 endpoint', async () => {
    const definition = builtinMcpToolFactory.createSdkMcpServer({ name: 'browser', version: '1', tools: [] })
    let loaded = 0
    const remote = { type: 'http', url: 'http://localhost:1234/external' }
    const endpoint = { type: 'http', url: 'http://localhost:4321/mcp', headers: { Authorization: 'fixture-only' } }
    const result = await materializeLocalCliMcpServers('session-a', {
      browser: createLazyBuiltinMcpServerDefinition({
        name: 'browser', description: '浏览器',
        load: async () => { loaded++; return definition },
      }),
      remote,
    }, {
      async materialize(owner, configs) {
        expect(owner).toBe('local-cli:session-a')
        expect(configs.browser).toBe(definition)
        expect(configs.remote).toBe(remote)
        return { browser: endpoint, remote }
      },
      async releaseSession() { throw new Error('成功路径不应提前释放') },
    })
    expect(loaded).toBe(1)
    expect(JSON.parse(JSON.stringify(result))).toEqual({ browser: endpoint, remote })
  })

  test('Given endpoint 创建中途失败 When 准备失败 Then 释放本次会话的部分资源', async () => {
    const released: string[] = []
    await expect(materializeLocalCliMcpServers('failed', {}, {
      async materialize() { throw new Error('模拟创建失败') },
      async releaseSession(owner) { released.push(owner) },
    })).rejects.toThrow('模拟创建失败')
    expect(released).toEqual(['local-cli:failed'])
  })

  test('Given 惰性加载失败或错误配置 When 准备 CLI Then 明确失败而不是丢弃工具', async () => {
    let hosted = false
    const host = {
      async materialize() { hosted = true; return {} },
      async releaseSession() {},
    }
    await expect(materializeLocalCliMcpServers('invalid', { invalid: null }, host)).rejects.toThrow('MCP 配置无效')
    await expect(materializeLocalCliMcpServers('failed', {
      lazy: createLazyBuiltinMcpServerDefinition({ name: 'lazy', description: '', load: async () => { throw new Error('初始化失败') } }),
    }, host)).rejects.toThrow('初始化失败')
    expect(hosted).toBe(false)
  })
})

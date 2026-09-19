import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { isBuiltinMcpServerDefinition } from '../builtin-mcp/tool-definition'
import { promaBuiltinMcpHttpHost } from '../builtin-mcp/http-host'
import { buildChatToolMcpDefinitions, materializeChatTools } from './chat-tool-mcp'
import { AGENT_RECOMMEND_TOOL_DEFINITIONS } from './agent-recommend-tool'

afterEach(async () => {
  await promaBuiltinMcpHttpHost.shutdown()
})

describe('Chat tools Local CLI MCP bridge', () => {
  test('Given Chat 推荐工具已启用 When 构建 MCP Then 注册真实可调用工具并改写提示词名称', async () => {
    const result = await buildChatToolMcpDefinitions({
      conversationId: 'conversation-1',
      cwd: '/tmp/proma-chat-tools',
      selection: {
        tools: AGENT_RECOMMEND_TOOL_DEFINITIONS,
        systemPromptAppend: '请调用 suggest_agent_mode',
        customTools: [],
      },
    })
    const server = result.servers.chat_tools
    expect(isBuiltinMcpServerDefinition(server)).toBe(true)
    if (!isBuiltinMcpServerDefinition(server)) throw new Error('Chat MCP 未生成')
    expect(result.allowedTools).toEqual(['mcp__chat_tools__suggest_agent_mode'])
    expect(result.systemPromptAppend).toContain('mcp__chat_tools__suggest_agent_mode')
    expect(await server.tools[0]?.execute({
      reason: '需要读取项目',
      suggestedPrompt: '请分析项目',
    })).toMatchObject({
      content: [{ type: 'text' }],
    })
  })

  test('Given Chat 自定义 HTTP 工具已启用 When 构建 MCP Then 注册到真实 Chat MCP Server', async () => {
    const result = await buildChatToolMcpDefinitions({
      conversationId: 'conversation-2',
      cwd: '/tmp/proma-chat-tools',
      selection: {
        tools: [{
          name: 'weather_lookup',
          description: '查询天气',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string', description: '城市' } },
            required: ['city'],
          },
        }],
        customTools: [{
          id: 'weather_lookup',
          name: '天气',
          description: '查询天气',
          params: [{ name: 'city', type: 'string', description: '城市', required: true }],
          category: 'custom',
          executorType: 'http',
          httpConfig: { method: 'GET', urlTemplate: 'https://example.invalid/{{city}}' },
        }],
      },
    })
    expect(result.allowedTools).toEqual(['mcp__chat_tools__weather_lookup'])
    expect(result.servers.chat_tools).toBeDefined()
  })

  test('Given Chat MCP 已物化 When CLI 客户端发现并调用 Then 返回旧 Chat 工具真实结果', async () => {
    const materialized = await materializeChatTools({
      runtimeSessionId: '8e4ac49f-48b4-57a6-8996-c0fe541ceaab',
      conversationId: 'conversation-mcp',
      cwd: '/tmp/proma-chat-tools',
      selection: {
        tools: AGENT_RECOMMEND_TOOL_DEFINITIONS,
        customTools: [],
      },
    })
    const config = materialized.mcpServers.chat_tools as {
      url: string
      headers: Record<string, string>
    }
    const client = new Client({ name: 'chat-mcp-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    }))
    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('suggest_agent_mode')
      const called = await client.callTool({
        name: 'suggest_agent_mode',
        arguments: { reason: '需要项目能力', suggestedPrompt: '检查项目' },
      })
      expect(JSON.stringify(called)).toContain('agent_recommendation')
    } finally {
      await client.close()
    }
  })
})

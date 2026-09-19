import { z, type ZodType } from 'zod'
import type { ChatToolMeta } from '@proma/shared'
import type { ToolDefinition } from '@proma/core'
import { builtinMcpToolFactory, isBuiltinMcpServerDefinition } from '../builtin-mcp/tool-definition'
import { promaBuiltinMcpHttpHost } from '../builtin-mcp/http-host'
import { getBuiltinMcpName } from '../builtin-mcp/baseline'
import { executeAgentRecommendTool } from './agent-recommend-tool'
import { executeHttpTool } from './http-tool-executor'

const CHAT_TOOLS_SERVER = 'chat_tools'

export interface ChatToolMcpSelection {
  tools?: ToolDefinition[]
  systemPromptAppend?: string
  customTools: ChatToolMeta[]
}

export interface ChatToolMcpInput {
  runtimeSessionId: string
  conversationId: string
  cwd: string
  enabledToolIds?: string[]
  /** 仅供纯测试或上层已解析配置时注入，生产默认读取 Chat 工具注册表。 */
  selection?: ChatToolMcpSelection
}

export interface MaterializedChatTools {
  mcpServers: Record<string, unknown>
  allowedTools: string[]
  systemPromptAppend?: string
}

interface CachedMaterializedChatTools {
  revision: string
  value: MaterializedChatTools
}

const materializedCache = new Map<string, CachedMaterializedChatTools>()

function schemaFor(meta: ChatToolMeta): Record<string, ZodType> {
  const shape: Record<string, ZodType> = {}
  for (const param of meta.params) {
    let schema: ZodType
    if (param.type === 'number') schema = z.number()
    else if (param.type === 'boolean') schema = z.boolean()
    else if (param.enum?.length) schema = z.enum(param.enum as [string, ...string[]])
    else schema = z.string()
    schema = schema.describe(param.description)
    shape[param.name] = param.required ? schema : schema.optional()
  }
  return shape
}

function toolResult(result: { content: string; isError?: boolean }): {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
} {
  return {
    content: [{ type: 'text', text: result.content }],
    ...(result.isError === true ? { isError: true } : {}),
  }
}

function canonicalToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

function rewriteToolNames(prompt: string | undefined, routes: Map<string, string>): string | undefined {
  if (!prompt) return undefined
  let rewritten = prompt
  for (const [legacyName, runtimeName] of [...routes].sort((left, right) => right[0].length - left[0].length)) {
    rewritten = rewritten.replaceAll(legacyName, runtimeName)
  }
  return rewritten
}

async function productionSelection(enabledToolIds?: string[]): Promise<ChatToolMcpSelection> {
  const [{ getEnabledTools }, { getChatToolsConfig }] = await Promise.all([
    import('../chat-tool-registry'),
    import('../chat-tool-config'),
  ])
  const enabled = getEnabledTools(enabledToolIds)
  return {
    tools: enabled.tools,
    systemPromptAppend: enabled.systemPromptAppend,
    customTools: getChatToolsConfig().customTools,
  }
}

/** 将旧 Chat function tools 构造成真实的内置 MCP server 定义。 */
export async function buildChatToolMcpDefinitions(
  input: Omit<ChatToolMcpInput, 'runtimeSessionId'>,
): Promise<{
  servers: Record<string, Record<string, unknown>>
  allowedTools: string[]
  systemPromptAppend?: string
  revision: string
}> {
  const selection = input.selection ?? await productionSelection(input.enabledToolIds)
  const selectedNames = new Set((selection.tools ?? []).map(tool => tool.name))
  const servers: Record<string, Record<string, unknown>> = {}
  const routes = new Map<string, string>()

  if (selectedNames.has('web_search')) {
    const { injectWebSearchMcpServer } = await import('../builtin-mcp/web-search-mcp')
    injectWebSearchMcpServer(builtinMcpToolFactory, servers)
  }
  if (selectedNames.has('generate_image')) {
    const { injectNanoBananaMcpServer } = await import('./nano-banana-mcp')
    await injectNanoBananaMcpServer(
      builtinMcpToolFactory,
      servers,
      input.conversationId,
      input.cwd,
    )
  }

  const directTools = []
  if (selectedNames.has('suggest_agent_mode')) {
    directTools.push(builtinMcpToolFactory.tool(
      'suggest_agent_mode',
      'Recommend switching this request to Agent mode and return the reason and suggested prompt.',
      {
        reason: z.string(),
        suggestedPrompt: z.string(),
      },
      async (args) => toolResult(await executeAgentRecommendTool({
        id: 'mcp-chat-agent-recommend',
        name: 'suggest_agent_mode',
        arguments: args,
      })),
      { annotations: { readOnlyHint: true } },
    ))
  }

  for (const meta of selection.customTools) {
    if (!selectedNames.has(meta.id) || meta.executorType !== 'http' || !meta.httpConfig) continue
    directTools.push(builtinMcpToolFactory.tool(
      meta.id,
      meta.description,
      schemaFor(meta),
      async (args) => toolResult(await executeHttpTool({
        id: `mcp-chat-custom-${meta.id}`,
        name: meta.id,
        arguments: args,
      }, meta)),
      meta.httpConfig.method === 'GET' ? { annotations: { readOnlyHint: true } } : undefined,
    ))
  }
  if (directTools.length > 0) {
    servers[CHAT_TOOLS_SERVER] = builtinMcpToolFactory.createSdkMcpServer({
      name: CHAT_TOOLS_SERVER,
      version: '1.0.0',
      tools: directTools,
    }) as unknown as Record<string, unknown>
  }

  const allowedTools: string[] = []
  for (const [serverName, definition] of Object.entries(servers)) {
    if (!isBuiltinMcpServerDefinition(definition)) continue
    for (const tool of definition.tools) {
      const canonical = canonicalToolName(serverName, tool.name)
      allowedTools.push(canonical)
      routes.set(tool.name, canonical)
    }
  }
  // 旧 Chat 对外叫 web_search；Agent MCP 实际提供 WebSearch/WebFetch。
  const webSearchServer = getBuiltinMcpName('web-search')
  if (selectedNames.has('web_search')) {
    routes.set('web_search', canonicalToolName(webSearchServer, 'WebSearch'))
  }
  const nanoBananaServer = getBuiltinMcpName('nano-banana')
  if (selectedNames.has('generate_image')) {
    routes.set('generate_image', canonicalToolName(nanoBananaServer, 'generate_image'))
  }

  return {
    servers,
    allowedTools,
    systemPromptAppend: rewriteToolNames(selection.systemPromptAppend, routes),
    revision: JSON.stringify({
      tools: (selection.tools ?? []).map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      customTools: selection.customTools
        .filter(tool => selectedNames.has(tool.id))
        .map(tool => ({
          id: tool.id,
          description: tool.description,
          params: tool.params,
          httpConfig: tool.httpConfig,
        })),
    }),
  }
}

/** 将内置定义托管成仅本机会话可访问的鉴权 HTTP MCP endpoints。 */
export async function materializeChatTools(input: ChatToolMcpInput): Promise<MaterializedChatTools> {
  const built = await buildChatToolMcpDefinitions(input)
  const cached = materializedCache.get(input.runtimeSessionId)
  if (cached?.revision === built.revision) return cached.value
  if (cached) await promaBuiltinMcpHttpHost.releaseSession(input.runtimeSessionId)
  const mcpServers = await promaBuiltinMcpHttpHost.materialize(input.runtimeSessionId, built.servers)
  const value = {
    mcpServers,
    allowedTools: built.allowedTools,
    systemPromptAppend: built.systemPromptAppend,
  }
  materializedCache.set(input.runtimeSessionId, { revision: built.revision, value })
  return value
}

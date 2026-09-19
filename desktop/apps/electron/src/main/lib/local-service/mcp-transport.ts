import { promaBuiltinMcpHttpHost } from '../builtin-mcp/http-host'
import { isLazyBuiltinMcpServerDefinition } from '../builtin-mcp/tool-definition'

interface McpTransportHost {
  materialize(sessionId: string, configs: Record<string, Record<string, unknown>>): Promise<Record<string, Record<string, unknown>>>
  releaseSession(sessionId: string): Promise<void>
}

/** CLI 只接收可序列化 transport；进程内工具始终由 Main 托管。 */
export async function materializeLocalCliMcpServers(
  sessionId: string,
  configs: Record<string, unknown> = {},
  host: McpTransportHost = promaBuiltinMcpHttpHost,
): Promise<Record<string, Record<string, unknown>>> {
  const definitions: Record<string, Record<string, unknown>> = {}
  for (const [name, value] of Object.entries(configs)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`MCP 配置无效：${name}`)
    }
    definitions[name] = isLazyBuiltinMcpServerDefinition(value)
      ? await value.load()
      : value as Record<string, unknown>
  }
  try {
    return await host.materialize(ownerId(sessionId), definitions)
  } catch (error) {
    await host.releaseSession(ownerId(sessionId))
    throw error
  }
}

export async function releaseLocalCliMcpServers(sessionId: string): Promise<void> {
  await promaBuiltinMcpHttpHost.releaseSession(ownerId(sessionId))
}

function ownerId(sessionId: string): string {
  // Chat 已物化的 endpoints 使用自己的所有权，不能被 Adapter 的清理误删。
  return `local-cli:${sessionId}`
}

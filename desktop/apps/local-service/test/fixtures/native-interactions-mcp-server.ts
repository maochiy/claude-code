import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

function requiredTracePath(): string {
  const tracePath = process.env.NATIVE_INTERACTIONS_MCP_TRACE
  if (!tracePath) throw new Error('NATIVE_INTERACTIONS_MCP_TRACE is required')
  return tracePath
}

async function record(tool: 'read_value' | 'write_value'): Promise<void> {
  const tracePath = requiredTracePath()
  await mkdir(dirname(tracePath), { recursive: true })
  await appendFile(
    tracePath,
    `${JSON.stringify({ tool, timestamp: Date.now() })}\n`,
    'utf8',
  )
}

const server = new McpServer({
  name: 'native-interactions-fixture',
  version: '1.0.0',
})

server.registerTool(
  'read_value',
  {
    description: 'Read an isolated fixture value without changing state.',
    annotations: {
      title: 'Read isolated fixture',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    await record('read_value')
    return {
      content: [{ type: 'text', text: 'isolated-read-value' }],
    }
  },
)

server.registerTool(
  'write_value',
  {
    description: 'Mutate only the isolated fixture trace.',
    annotations: {
      title: 'Write isolated fixture',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async () => {
    await record('write_value')
    return {
      content: [{ type: 'text', text: 'isolated-write-complete' }],
    }
  },
)

await server.connect(new StdioServerTransport())

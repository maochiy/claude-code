import {
  createWorkflowTool,
  workflowInputSchema,
  WORKFLOW_TOOL_NAME,
  type WorkflowToolDescriptor,
} from '@claude-code-best/workflow-engine'
import { buildTool, type Tool } from '../Tool.js'
import {
  areDynamicWorkflowsEnabled,
  constrainWorkflowConcurrency,
} from '../utils/dynamicWorkflows.js'
import { getWorkflowService } from './service.js'

/**
 * Adapts the engine's self-contained descriptor into a buildTool-compatible Tool.
 * The descriptor routes through the service singleton (sharing ports/registry/store).
 *
 * ports resolution is deferred to the first real method call (lazy): tools.ts calls
 * createWorkflowToolCore() during module-load (feature-gated), and resolving ports
 * immediately would trigger service instantiation, which in turn calls module-level
 * side effects like getProjectRoot — yielding wrong paths before bootstrap completes.
 * The Tool object itself is a singleton via createWorkflowToolCore's cached (PermissionRequest
 * matches by reference), and the ports singleton is guaranteed by getWorkflowService.
 */
function buildWorkflowTool(): Tool {
  let cachedDescriptor: WorkflowToolDescriptor | null = null
  const descriptor = (): WorkflowToolDescriptor => {
    if (!cachedDescriptor) {
      const { ports } = getWorkflowService()
      cachedDescriptor = createWorkflowTool(ports)
    }
    return cachedDescriptor
  }
  return buildTool({
    name: WORKFLOW_TOOL_NAME,
    maxResultSizeChars: 50_000,
    inputSchema: workflowInputSchema,
    isEnabled: () => descriptor().isEnabled(),
    isReadOnly: input => descriptor().isReadOnly(input),
    isConcurrencySafe: () => areDynamicWorkflowsEnabled(),
    async description() {
      return descriptor().description()
    },
    async prompt() {
      const prompt = await descriptor().prompt()
      return areDynamicWorkflowsEnabled()
        ? prompt
        : `${prompt}\n\nThis session permits one subagent at a time. maxConcurrency is fixed to 1.`
    },
    async call(input, context, canUseTool, parentMessage, onProgress) {
      const result = await descriptor().call(
        constrainWorkflowConcurrency(input),
        context,
        canUseTool,
        parentMessage,
        onProgress,
      )
      return { data: result.data }
    },
    renderToolUseMessage: input => descriptor().renderToolUseMessage(input),
    mapToolResultToToolResultBlockParam: (data, toolUseId) =>
      descriptor().mapToolResultToToolResultBlockParam(data, toolUseId),
  })
}

// Singleton: tools.ts registration and PermissionRequest must reference the same instance (switch matches by reference).
let cached: Tool | null = null

export function createWorkflowToolCore(): Tool {
  if (!cached) cached = buildWorkflowTool()
  return cached
}

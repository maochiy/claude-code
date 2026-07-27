import type { ChatGPTCredentialUpdate } from '../../services/api/openai/chatgptAuth.js'
import type {
  RuntimeAskUserRequest,
  RuntimeInteractionResponse,
  RuntimePermissionRequest,
  RuntimePlanRequest,
} from '../protocol/types.js'

export interface ClaudeCodeDesktopHostBridge {
  requestPermission(
    request: RuntimePermissionRequest,
  ): Promise<RuntimeInteractionResponse>
  askUser(request: RuntimeAskUserRequest): Promise<RuntimeInteractionResponse>
  approvePlan(request: RuntimePlanRequest): Promise<RuntimeInteractionResponse>
  emitCredentialsUpdated(credentials: ChatGPTCredentialUpdate): void
}

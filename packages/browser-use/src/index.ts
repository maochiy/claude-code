export {
  PROTOCOL,
  MAX_FRAME_BYTES,
  BrowserError,
  requestEnvelope,
  responseEnvelope,
  errorEnvelope,
  validateMessage,
  encodeFrame,
  FrameDecoder,
} from './protocol.js'
export type {
  ProtocolMessage,
  RequestEnvelope,
  ResponseEnvelope,
  EventEnvelope,
  RequestExtra,
  SerializedError,
} from './protocol.js'
export { TaskRegistry } from './task-registry.js'
export type { TaskRecord, TaskOwnership } from './task-registry.js'
export {
  BROWSER_PIPE_NAME,
  getBrowserSocketDir,
  getHostSocketPath,
} from './paths.js'
export {
  BrowserSocketClient,
  getBrowserClient,
  discoverHostSocketPaths,
} from './socket-client.js'
export { BrowserHostBridge, runBrowserNativeHost } from './host-bridge.js'
export { BrowserBackend, DEFAULT_SESSION_ID } from './backend.js'
export type { BackendClient, BrowserScope } from './backend.js'

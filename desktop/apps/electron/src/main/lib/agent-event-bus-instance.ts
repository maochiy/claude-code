import { AgentEventBus } from './agent-event-bus'

/**
 * Main 进程共享的 Agent 事件总线。
 *
 * 单例独立于 Electron 窗口服务，Bridge 的本地 mock 可以在不加载 BrowserWindow
 * 的情况下验证 headless 消息链。
 */
export const agentEventBus = new AgentEventBus()

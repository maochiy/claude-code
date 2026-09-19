import { appendSDKMessages, getAgentSessionSDKMessages } from './agent-session-manager'
import { BackgroundTaskService } from './background-task-service'

/** 应用进程内唯一的后台任务注册表。 */
export const backgroundTaskService = new BackgroundTaskService({
  appendMessages: appendSDKMessages,
  loadMessages: getAgentSessionSDKMessages,
  now: Date.now,
})

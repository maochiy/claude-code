/**
 * 用户档案类型
 *
 * 用户名、头像、IPC 通道等定义。
 */

/** 默认用户头像 emoji */
export const DEFAULT_USER_AVATAR = '🧑‍💻'

/** 默认用户名 */
export const DEFAULT_USER_NAME = '用户'

/** 用户档案 */
export interface UserProfile {
  /** 用户名 */
  userName: string
  /** 头像（emoji 字符串 或 data:image/* base64 URL） */
  avatar: string
}

/** 按日汇总的 Token 用量 */
export interface UserUsageDay {
  /** 本地日期 YYYY-MM-DD */
  day: string
  /** 当日真实消耗 Token（input + output + cache） */
  tokens: number
  /** 当日模型请求次数 */
  requests: number
  /** 当日 Cowork 模式真实消耗 Token */
  coworkTokens: number
  /** 当日 Code 模式真实消耗 Token */
  codeTokens: number
  /** 当日 Cowork 模式模型请求次数 */
  coworkRequests: number
  /** 当日 Code 模式模型请求次数 */
  codeRequests: number
  /** Code 用量中由 Auto classifier 独立调用产生的 Token。 */
  autoTokens?: number
  /** 当日 Auto classifier 独立调用次数。 */
  autoRequests?: number
  /** 当日真实用户消息数；旧汇总缺失时为 undefined */
  userMessages?: number
  /** 当日完成的用户轮次 */
  turns?: number
  /** 当日 Runtime 明确上报的模型调用数 */
  modelCalls?: number
  /** 当日新建的 Agent/Code 会话数 */
  agentSessions?: number
  /** 当日新建的 Chat/Cowork 会话数 */
  chatSessions?: number
}

/** 模型用量排行项 */
export interface UserUsageModel {
  /** 模型 ID */
  modelId: string
  /** 展示名称 */
  modelName: string
  /** 调用次数 */
  requests: number
  /** 累计 Token */
  tokens: number
  /** 其中由 Auto classifier 独立调用产生的 Token。 */
  autoTokens?: number
  /** Auto classifier 独立调用次数。 */
  autoRequests?: number
  /** 最近一次使用时间戳 */
  lastUsedAt: number
  /** 按本地日期拆分，供范围筛选；旧汇总可能缺失 */
  days?: Array<{ day: string; tokens: number; requests: number }>
}

export type UserUsageCollectionState = 'complete' | 'partial' | 'unavailable'

/** 用量数据覆盖情况。零用量与读取不到数据必须分开表达。 */
export interface UserUsageCoverage {
  /** Code/Agent JSONL 的读取状态 */
  code: UserUsageCollectionState
  /** Cowork 历史是否有真实 usage；当前旧存储通常不可用 */
  cowork: UserUsageCollectionState
  /** 扫描失败的 Agent 会话数 */
  failedAgentSessions: number
  /** 参与扫描的非草稿 Agent 会话数 */
  totalAgentSessions: number
}

/** Skill 用量排行项 */
export interface UserUsageSkill {
  /** Skill 名称 */
  name: string
  /** 调用次数 */
  uses: number
  /** 最近一次使用时间戳 */
  lastUsedAt: number
}

/** 个人资料页顶部统计与洞察 */
export interface UserUsageStats {
  /** 累计 Token */
  totalTokens: number
  /** 峰值日 Token */
  peakDayTokens: number
  /** 峰值日 YYYY-MM-DD */
  peakDay: string
  /** 单会话最长时长（毫秒，首次活动到末次活动） */
  longestChatDurationMs: number
  /** 当前连续活跃天数（需包含今天） */
  currentStreakDays: number
  /** 历史最长连续活跃天数 */
  longestStreakDays: number
  /** 模型请求次数 */
  requests: number
  /** Auto classifier 独立调用 Token。 */
  autoTokens?: number
  /** Auto classifier 独立调用次数。 */
  autoRequests?: number
  /** 真实用户消息数 */
  userMessages?: number
  /** 已完成的用户轮次数 */
  turns?: number
  /** Runtime 明确上报的模型调用数；旧记录缺失时只统计已知部分 */
  modelCalls?: number
  /** Chat 对话数 */
  chatCount: number
  /** Agent 会话数（不含 draft） */
  agentSessionCount: number
  /** 快速模式占比 0-1 */
  fastModeRate: number
  /** 使用过的 Skill 种数 */
  skillsExplored: number
  /** Skill 调用总次数 */
  skillUses: number
}

/** 个人资料用量汇总 */
export interface UserUsageSummary {
  /** 汇总生成时间戳 */
  checkedAt: number
  stats: UserUsageStats
  /** 有用量的日期，供热力图使用 */
  days: UserUsageDay[]
  /** 最常用模型，按调用次数降序 */
  models: UserUsageModel[]
  /** 最常用 Skill，按调用次数降序 */
  skills: UserUsageSkill[]
  /** 数据覆盖情况；旧版响应可能缺失 */
  coverage?: UserUsageCoverage
}

/** 用户档案 IPC 通道 */
export const USER_PROFILE_IPC_CHANNELS = {
  GET: 'user-profile:get',
  UPDATE: 'user-profile:update',
  GET_USAGE_SUMMARY: 'user-profile:get-usage-summary',
} as const

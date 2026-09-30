export type ChatGPTCodexModelOption = {
  value: string
  label: string
  description: string
}

/** Default ChatGPT/Codex model (newest flagship-per-cost). */
export const CHATGPT_CODEX_DEFAULT_MODEL = 'gpt-6.1-sol'
export const CHATGPT_CODEX_BALANCED_MODEL = 'gpt-5.6-terra'
/** Fast/small default for lighter tasks. */
export const CHATGPT_CODEX_FAST_MODEL = 'gpt-5.6-luna'

export const CHATGPT_CODEX_MODELS_BY_TIER = {
  opus: 'gpt-6-astra',
  sonnet: 'gpt-6.1-sol',
  haiku: 'gpt-5.6-luna',
} as const

export type ChatGPTCodexModelTier = keyof typeof CHATGPT_CODEX_MODELS_BY_TIER

/** Resolve one CCB capability tier without coupling the policy to settings. */
export function resolveChatGPTCodexModelForTier(params: {
  tier: ChatGPTCodexModelTier
  isChatGPTAuth: boolean
  tierOverride?: string
  taskOverride?: string
}): string | undefined {
  return (
    params.taskOverride ??
    params.tierOverride ??
    (params.isChatGPTAuth
      ? CHATGPT_CODEX_MODELS_BY_TIER[params.tier]
      : undefined)
  )
}

/**
 * ChatGPT OAuth / Codex subscription practical context window.
 * Codex with ChatGPT login is product-limited to ~272k (not the full API 1.05M).
 */
export const CHATGPT_OAUTH_CONTEXT_WINDOW = 272_000

/**
 * GPT-5.6 family context window on the OpenAI API model card (API key path).
 * Long-context pricing applies above 272k input tokens.
 */
export const CHATGPT_API_CONTEXT_WINDOW = 1_050_000

/** @deprecated Use CHATGPT_OAUTH_CONTEXT_WINDOW or CHATGPT_API_CONTEXT_WINDOW. */
export const CHATGPT_CODEX_CONTEXT_WINDOW = CHATGPT_OAUTH_CONTEXT_WINDOW

/** Official GPT-5.6 family max output tokens (OpenAI model card). */
export const CHATGPT_CODEX_MAX_OUTPUT_TOKENS = 128_000

/**
 * ChatGPT OAuth / Codex model picker options.
 *
 * Current lineup (as of Sep 30, 2026):
 * - GPT-6.1 Sol: released 2026-09-29 (DevDay) — near-Astra intelligence at
 *   1/5 of Astra's token cost. GPT-6.1 Astra was scrapped over safety review.
 * - GPT-6 Astra: current frontier flagship (recommended by OpenAI for Codex).
 * - GPT-6 Sol / Luna: first GPT-6 generation.
 * - GPT-5.6 Sol / Terra / Luna: previous family, still available.
 * - gpt-5.5: retires from Codex on 2026-10-14 (API still available).
 * - gpt-5.3-codex-spark: research preview, ChatGPT Pro only.
 */
export const CHATGPT_CODEX_MODEL_OPTIONS: ChatGPTCodexModelOption[] = [
  {
    value: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    description:
      'Newest release · near-Astra intelligence at 1/5 of the token cost',
  },
  {
    value: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    description: 'Current frontier flagship · highest capability',
  },
  {
    value: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    description: 'Strong GPT-6 generation model for complex work',
  },
  {
    value: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    description: 'Fast GPT-6 generation model for lighter tasks',
  },
  {
    value: 'gpt-5.6-sol',
    label: 'gpt-5.6-sol',
    description:
      'Frontier model for complex coding, research, and real-world work',
  },
  {
    value: 'gpt-5.6-terra',
    label: 'gpt-5.6-terra',
    description: 'Strong model for everyday coding',
  },
  {
    value: 'gpt-5.6-luna',
    label: 'gpt-5.6-luna',
    description:
      'Small, fast, and cost-efficient model for simpler coding tasks',
  },
  {
    value: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'Previous flagship · retires from Codex on Oct 14, 2026',
  },
  {
    value: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3-Codex-Spark',
    description: 'Ultra-fast research preview (ChatGPT Pro)',
  },
]

export function isChatGPTAuthMode(): boolean {
  return process.env.OPENAI_AUTH_MODE === 'chatgpt'
}

function normalizeChatGPTModelId(model: string): string {
  return model.toLowerCase().replace(/\[1m\]$/i, '')
}

/**
 * Whether this is a GPT-5.6 family model id (Sol/Terra/Luna or bare `gpt-5.6`).
 */
export function isGpt56FamilyModel(model: string): boolean {
  const normalized = normalizeChatGPTModelId(model)
  return normalized === 'gpt-5.6' || normalized.startsWith('gpt-5.6-')
}

/** Whether this is a GPT-6 family model id (Astra/Sol/Luna/6.1 variants). */
export function isGpt6FamilyModel(model: string): boolean {
  const normalized = normalizeChatGPTModelId(model)
  return (
    normalized === 'gpt-6' ||
    normalized.startsWith('gpt-6-') ||
    normalized.startsWith('gpt-6.')
  )
}

export function isChatGPTCodexReasoningModel(model: string): boolean {
  const normalized = normalizeChatGPTModelId(model)
  return (
    isGpt56FamilyModel(model) ||
    isGpt6FamilyModel(model) ||
    CHATGPT_CODEX_MODEL_OPTIONS.some(
      option => option.value.toLowerCase() === normalized,
    )
  )
}

/**
 * Context window for GPT-5.6 models used by CCB for local budgeting
 * (status bar %, auto-compact thresholds). Not sent as a request field.
 *
 * - ChatGPT OAuth / Codex backend: 272k (subscription product limit)
 * - API key / OpenAI-compatible using gpt-5.6-*: 1.05M (model card)
 */
export function getChatGPTModelContextWindow(
  model: string,
): number | undefined {
  if (!isGpt56FamilyModel(model) && !isGpt6FamilyModel(model)) {
    return undefined
  }
  return isChatGPTAuthMode()
    ? CHATGPT_OAUTH_CONTEXT_WINDOW
    : CHATGPT_API_CONTEXT_WINDOW
}

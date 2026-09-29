import type {
  ConfiguredModel,
  ProviderProfile,
  ProviderProfileType,
  SettingsJson,
} from '../settings/types.js'
import {
  getSettings_DEPRECATED,
  updateSettingsForSource,
} from '../settings/settings.js'

export type {
  ProviderProfile,
  ProviderProfileType,
} from '../settings/types.js'

export const PROVIDER_PROFILE_TYPES: readonly ProviderProfileType[] = [
  'anthropic',
  'openai',
  'gemini',
  'grok',
]

export function isProviderProfileType(
  value: string,
): value is ProviderProfileType {
  return (PROVIDER_PROFILE_TYPES as readonly string[]).includes(value)
}

/**
 * Environment variables owned by each provider type. When switching the
 * active provider, keys belonging to the *previous* provider are removed from
 * process.env / settings.env so stale credentials can't leak into the new
 * provider's client construction.
 */
const PROVIDER_ENV_KEYS: Record<ProviderProfileType, readonly string[]> = {
  anthropic: [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
    'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
    'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
    'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
    'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  ],
  openai: [
    'OPENAI_AUTH_MODE',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'OPENAI_DEFAULT_HAIKU_MODEL',
    'OPENAI_DEFAULT_SONNET_MODEL',
    'OPENAI_DEFAULT_OPUS_MODEL',
    'OPENAI_DEFAULT_HAIKU_MODEL_NAME',
    'OPENAI_DEFAULT_SONNET_MODEL_NAME',
    'OPENAI_DEFAULT_OPUS_MODEL_NAME',
    'OPENAI_DEFAULT_HAIKU_MODEL_DESCRIPTION',
    'OPENAI_DEFAULT_SONNET_MODEL_DESCRIPTION',
    'OPENAI_DEFAULT_OPUS_MODEL_DESCRIPTION',
  ],
  gemini: [
    'GEMINI_BASE_URL',
    'GEMINI_API_KEY',
    'GEMINI_MODEL',
    'GEMINI_DEFAULT_HAIKU_MODEL',
    'GEMINI_DEFAULT_SONNET_MODEL',
    'GEMINI_DEFAULT_OPUS_MODEL',
    'GEMINI_DEFAULT_HAIKU_MODEL_NAME',
    'GEMINI_DEFAULT_SONNET_MODEL_NAME',
    'GEMINI_DEFAULT_OPUS_MODEL_NAME',
    'GEMINI_DEFAULT_HAIKU_MODEL_DESCRIPTION',
    'GEMINI_DEFAULT_SONNET_MODEL_DESCRIPTION',
    'GEMINI_DEFAULT_OPUS_MODEL_DESCRIPTION',
  ],
  grok: [
    'GROK_API_KEY',
    'XAI_API_KEY',
    'GROK_BASE_URL',
    'GROK_MODEL',
    'GROK_DEFAULT_HAIKU_MODEL',
    'GROK_DEFAULT_SONNET_MODEL',
    'GROK_DEFAULT_OPUS_MODEL',
  ],
}

/** Mapping from a provider profile's fields to its env keys. */
function profileToEnv(
  type: ProviderProfileType,
  profile: ProviderProfile,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  if (type === 'anthropic') {
    env.ANTHROPIC_BASE_URL = profile.baseUrl || undefined
    env.ANTHROPIC_AUTH_TOKEN = profile.apiKey || undefined
  } else if (type === 'openai') {
    env.OPENAI_AUTH_MODE =
      profile.authMode === 'chatgpt' ? 'chatgpt' : undefined
    env.OPENAI_BASE_URL =
      profile.authMode === 'chatgpt' ? undefined : profile.baseUrl || undefined
    env.OPENAI_API_KEY =
      profile.authMode === 'chatgpt' ? undefined : profile.apiKey || undefined
  } else if (type === 'gemini') {
    env.GEMINI_BASE_URL = profile.baseUrl || undefined
    env.GEMINI_API_KEY = profile.apiKey || undefined
  } else {
    env.GROK_BASE_URL = profile.baseUrl || undefined
    env.GROK_API_KEY = profile.apiKey || undefined
  }
  return env
}

/**
 * Resolve a profile's protocol: explicit `type` field wins; legacy entries
 * keyed by their type name fall back to the key itself.
 */
export function resolveProfileType(
  name: string,
  profile: ProviderProfile | undefined,
): ProviderProfileType | undefined {
  if (profile?.type) return profile.type
  if (isProviderProfileType(name)) return name
  return undefined
}

/**
 * Currently active provider profile type = the protocol of the active
 * profile (mirrors settings.modelType). Returns undefined for
 * first-party/cloud (bedrock/vertex/foundry) setups.
 */
export function getActiveProviderProfileType(
  settings: SettingsJson = getSettings_DEPRECATED() || {},
): ProviderProfileType | undefined {
  const activeName = getActiveProviderProfileName(settings)
  if (activeName) {
    return resolveProfileType(activeName, settings.providers?.[activeName])
  }
  const modelType = settings.modelType
  return modelType && isProviderProfileType(modelType) ? modelType : undefined
}

/**
 * Name of the currently active provider profile. Falls back to the legacy
 * type-name convention (modelType) when activeProvider is not set.
 */
export function getActiveProviderProfileName(
  settings: SettingsJson = getSettings_DEPRECATED() || {},
): string | undefined {
  if (
    settings.activeProvider &&
    settings.providers?.[settings.activeProvider]
  ) {
    return settings.activeProvider
  }
  const modelType = settings.modelType
  if (modelType && isProviderProfileType(modelType)) {
    // Legacy convention: the profile (if any) is stored under its type name.
    return modelType
  }
  return undefined
}

/**
 * Get a saved profile by provider NAME. Falls back to a legacy view
 * synthesized from the flattened settings.env when the name refers to a
 * provider type only configured through the pre-profile mechanism, so
 * configs written by older versions keep working without a migration step.
 */
export function getProviderProfile(
  name: string,
  settings: SettingsJson = getSettings_DEPRECATED() || {},
): ProviderProfile | undefined {
  const saved = settings.providers?.[name]
  const legacy = isProviderProfileType(name)
    ? legacyProfileFromSettings(name, settings)
    : undefined
  if (!saved) return legacy
  if (!legacy) return saved
  // Legacy env wins for keys the user may have overridden after saving.
  return {
    baseUrl: legacy.baseUrl ?? saved.baseUrl,
    apiKey: legacy.apiKey ?? saved.apiKey,
    authMode: saved.authMode ?? legacy.authMode,
    models: saved.models ?? legacy.models,
    defaultModel: saved.defaultModel ?? legacy.defaultModel,
  }
}

/**
 * Find a profile by PROTOCOL — used by type-oriented callers (e.g. the
 * /login setup form prefills). Prefers the active profile when its protocol
 * matches, otherwise the first configured profile of that type.
 */
export function getProfileForProviderType(
  type: ProviderProfileType,
  settings: SettingsJson = getSettings_DEPRECATED() || {},
): { name: string; profile: ProviderProfile } | undefined {
  const activeName = getActiveProviderProfileName(settings)
  if (activeName) {
    const activeProfile = getProviderProfile(activeName, settings)
    if (resolveProfileType(activeName, activeProfile) === type) {
      return { name: activeName, profile: activeProfile ?? {} }
    }
  }
  for (const entry of getConfiguredProviderProfiles(settings)) {
    if (entry.type === type) return { name: entry.name, profile: entry.profile }
  }
  return undefined
}

/**
 * True when a provider has enough saved config to be selectable in /model.
 * ChatGPT-auth openai profiles only need the auth mode (token lives in the
 * ChatGPT auth file); everything else needs an api key. A profile with only
 * a model catalog but no credentials is NOT selectable — activating it would
 * send unauthenticated requests.
 */
export function isProviderProfileConfigured(
  profile: ProviderProfile | undefined,
): boolean {
  if (!profile) return false
  if (profile.authMode === 'chatgpt') return true
  return !!profile.apiKey
}

/**
 * Enumerate every named provider profile with saved/legacy config, for
 * pickers. Legacy type-keyed entries surface under their type name.
 */
export function getConfiguredProviderProfiles(
  settings: SettingsJson = getSettings_DEPRECATED() || {},
): Array<{
  name: string
  type: ProviderProfileType
  profile: ProviderProfile
}> {
  const result: Array<{
    name: string
    type: ProviderProfileType
    profile: ProviderProfile
  }> = []
  const savedProviders = settings.providers ?? {}
  // Protocols that already have a real profile — the legacy type-name view
  // is skipped for these, otherwise the same config (snapshotted into the
  // named profile) would show up twice under a protocol pseudo-name.
  const existingTypes = new Set(
    Object.entries(savedProviders)
      .map(([key, profile]) => resolveProfileType(key, profile))
      .filter((t): t is ProviderProfileType => t !== undefined),
  )
  const names = new Set([
    ...Object.keys(savedProviders),
    ...PROVIDER_PROFILE_TYPES.filter(type => !existingTypes.has(type)),
  ])
  for (const name of names) {
    const profile = getProviderProfile(name, settings)
    const type = resolveProfileType(name, profile)
    if (!type) continue
    if (isProviderProfileConfigured(profile) && profile) {
      result.push({ name, type, profile })
    }
  }
  return result
}

function legacyProfileFromSettings(
  type: ProviderProfileType,
  settings: SettingsJson,
): ProviderProfile | undefined {
  const activeName = getActiveProviderProfileName(settings)
  const env = settings.env ?? {}

  if (activeName !== type) {
    // Inactive providers have no top-level state. Pick up shell-exported
    // config (e.g. a manually exported OPENAI_API_KEY) so the provider still
    // shows up in pickers, but never treat first-party OAuth-only setups as
    // a configured profile.
    const profile: ProviderProfile = {}
    if (type === 'anthropic') {
      if (process.env.ANTHROPIC_BASE_URL)
        profile.baseUrl = process.env.ANTHROPIC_BASE_URL
      if (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
        profile.apiKey =
          process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY
      }
    } else if (type === 'openai') {
      if (process.env.OPENAI_AUTH_MODE === 'chatgpt') {
        profile.authMode = 'chatgpt'
      } else {
        if (process.env.OPENAI_BASE_URL)
          profile.baseUrl = process.env.OPENAI_BASE_URL
        if (process.env.OPENAI_API_KEY)
          profile.apiKey = process.env.OPENAI_API_KEY
      }
    } else if (type === 'gemini') {
      if (process.env.GEMINI_BASE_URL)
        profile.baseUrl = process.env.GEMINI_BASE_URL
      if (process.env.GEMINI_API_KEY)
        profile.apiKey = process.env.GEMINI_API_KEY
    } else {
      if (process.env.GROK_BASE_URL) profile.baseUrl = process.env.GROK_BASE_URL
      if (process.env.GROK_API_KEY ?? process.env.XAI_API_KEY) {
        profile.apiKey = process.env.GROK_API_KEY ?? process.env.XAI_API_KEY
      }
    }
    return profile.apiKey || profile.authMode ? profile : undefined
  }

  const profile: ProviderProfile = { type }
  if (type === 'anthropic') {
    profile.baseUrl = env.ANTHROPIC_BASE_URL
    profile.apiKey = env.ANTHROPIC_AUTH_TOKEN
  } else if (type === 'openai') {
    if (env.OPENAI_AUTH_MODE === 'chatgpt') {
      profile.authMode = 'chatgpt'
    } else {
      profile.baseUrl = env.OPENAI_BASE_URL
      profile.apiKey = env.OPENAI_API_KEY
    }
  } else if (type === 'gemini') {
    profile.baseUrl = env.GEMINI_BASE_URL
    profile.apiKey = env.GEMINI_API_KEY
  } else {
    profile.baseUrl = env.GROK_BASE_URL
    profile.apiKey = env.GROK_API_KEY ?? env.XAI_API_KEY
  }
  if (settings.models?.length) {
    profile.models = settings.models
    profile.defaultModel = settings.model
  }
  const hasAny =
    profile.baseUrl || profile.apiKey || profile.authMode || profile.models
  return hasAny ? profile : undefined
}

/**
 * Snapshot the currently-active provider's flattened top-level state
 * (env keys, model catalog, default model) into its profile. Called before
 * activating another provider so switching back and forth is lossless —
 * this is what prevents the old "configuring provider B wipes provider A"
 * behavior.
 */
function snapshotActiveProvider(settings: SettingsJson): string | undefined {
  const activeName = getActiveProviderProfileName(settings)
  if (!activeName) return undefined
  const activeType = resolveProfileType(
    activeName,
    settings.providers?.[activeName],
  )
  if (!activeType) return undefined

  const env = settings.env ?? {}
  const snapshot: ProviderProfile = {
    type: activeType,
    ...(settings.providers?.[activeName] ?? {}),
  }
  if (activeType === 'anthropic') {
    if (env.ANTHROPIC_BASE_URL) snapshot.baseUrl = env.ANTHROPIC_BASE_URL
    if (env.ANTHROPIC_AUTH_TOKEN) snapshot.apiKey = env.ANTHROPIC_AUTH_TOKEN
  } else if (activeType === 'openai') {
    if (env.OPENAI_AUTH_MODE === 'chatgpt') {
      snapshot.authMode = 'chatgpt'
    } else {
      if (env.OPENAI_BASE_URL) snapshot.baseUrl = env.OPENAI_BASE_URL
      if (env.OPENAI_API_KEY) snapshot.apiKey = env.OPENAI_API_KEY
    }
  } else if (activeType === 'gemini') {
    if (env.GEMINI_BASE_URL) snapshot.baseUrl = env.GEMINI_BASE_URL
    if (env.GEMINI_API_KEY) snapshot.apiKey = env.GEMINI_API_KEY
  } else {
    if (env.GROK_BASE_URL) snapshot.baseUrl = env.GROK_BASE_URL
    if (env.GROK_API_KEY ?? env.XAI_API_KEY)
      snapshot.apiKey = env.GROK_API_KEY ?? env.XAI_API_KEY
  }
  if (settings.models?.length) {
    snapshot.models = settings.models
    snapshot.defaultModel = settings.model
  }

  updateSettingsForSource('userSettings', {
    providers: { [activeName]: snapshot },
  })
  return activeName
}

/**
 * Proxy URL configured on the ACTIVE provider profile.
 * - URL string → route this provider's requests through it.
 * - `''` → the profile explicitly wants a direct connection (no proxy).
 * - `undefined` → no active profile / no proxy preference (callers fall back
 *   to the standard env/system lookup).
 */
export function getActiveProviderProxyUrl(): string | undefined {
  const name = getActiveProviderProfileName()
  if (!name) return undefined
  const profile = getProviderProfile(name)
  if (!profile) return undefined
  return profile.proxy ?? ''
}

/**
 * Save (merge) a provider profile without activating it.
 */
export function saveProviderProfile(
  name: string,
  profile: ProviderProfile,
): { error: Error | null } {
  const settings = getSettings_DEPRECATED() || {}
  const existing = settings.providers?.[name] ?? {}
  return updateSettingsForSource('userSettings', {
    providers: { [name]: { ...existing, ...profile } },
  })
}

export type ActivateProviderOptions = {
  /** Protocol for a brand-new profile (required when the name isn't a type). */
  type?: ProviderProfileType
  /** Connection config to save into the profile (overrides saved values). */
  baseUrl?: string
  apiKey?: string
  /** Proxy URL for this provider ('' = force direct). */
  proxy?: string
  /**
   * Auth mode for openai profiles. 'chatgpt' = ChatGPT subscription OAuth;
   * null explicitly clears a previously saved auth mode (back to API key).
   */
  authMode?: 'chatgpt' | null
  /** New catalog to install for the provider (replaces the profile's models). */
  models?: ConfiguredModel[]
  /** Default model id to set when activating. */
  model?: string
  /** Remove the provider's custom model catalog (fall back to built-ins). */
  clearModelCatalog?: boolean
}

/**
 * Activate a provider profile by NAME: snapshot the previously-active
 * provider into its own profile, then copy the target profile's connection
 * config and model catalog into the top-level settings/env fields that the
 * rest of the code reads. Returns the env patch applied to process.env so
 * callers can react (e.g. drop cached API clients).
 */
export function activateProviderProfile(
  name: string,
  options: ActivateProviderOptions = {},
): { error: Error | null; envPatch: Record<string, string | undefined> } {
  const settings = getSettings_DEPRECATED() || {}

  // 1. Persist the outgoing provider's state into its own profile.
  snapshotActiveProvider(settings)

  // 2. Compute the new provider's env: its own keys from the profile, and
  //    explicit deletion of the previous provider's keys.
  const profile: ProviderProfile = {
    ...(settings.providers?.[name] ?? {}),
    ...(options.type ? { type: options.type } : {}),
  }
  const type = resolveProfileType(name, profile)
  if (!type) {
    return {
      error: new Error(
        `Provider profile "${name}" has no protocol type — re-save it via /login.`,
      ),
      envPatch: {},
    }
  }
  if (!profile.type) profile.type = type
  if (options.baseUrl !== undefined)
    profile.baseUrl = options.baseUrl || undefined
  if (options.apiKey !== undefined) profile.apiKey = options.apiKey || undefined
  if (options.proxy !== undefined) profile.proxy = options.proxy || undefined
  if (options.authMode !== undefined) {
    profile.authMode = options.authMode === 'chatgpt' ? 'chatgpt' : undefined
  }
  // Shallow copy: updateSettingsForSource below may mutate settings.env
  // in place (session caches), which would defeat the "was it settings-managed"
  // check in step 4.
  const previousSettingsEnv = { ...settings.env }
  const envPatch: Record<string, string | undefined> = {
    ...profileToEnv(type, profile),
  }
  for (const otherType of PROVIDER_PROFILE_TYPES) {
    if (otherType === type) continue
    for (const key of PROVIDER_ENV_KEYS[otherType]) {
      envPatch[key] = undefined
    }
  }
  // Drop the legacy single-provider model env overrides — the catalog comes
  // from `models` now.
  for (const key of PROVIDER_ENV_KEYS[type]) {
    if (
      key.endsWith('_MODEL') &&
      !key.endsWith('_MODEL_NAME') &&
      !key.endsWith('_MODEL_DESCRIPTION')
    ) {
      envPatch[key] = undefined
    }
  }

  const models = options.clearModelCatalog
    ? undefined
    : (options.models ?? profile.models)
  const model = options.clearModelCatalog
    ? undefined
    : (options.model ?? profile.defaultModel)

  // 3. Write top-level fields + save profile updates in one settings write.
  const providersUpdate: NonNullable<SettingsJson['providers']> = {
    ...(settings.providers ?? {}),
  }
  if (options.models) profile.models = options.models
  if (options.model) profile.defaultModel = options.model
  if (options.clearModelCatalog) {
    delete profile.models
    delete profile.defaultModel
  }
  providersUpdate[name] = profile

  const { error } = updateSettingsForSource('userSettings', {
    modelType: type,
    activeProvider: name,
    model,
    models,
    env: envPatch as Record<string, string>,
    providers: providersUpdate,
  })
  if (error) {
    return { error, envPatch: {} }
  }

  // 4. Apply the env patch to the live process. The active turn keeps using
  //    the old provider's client; the next turn picks this up. Keys that only
  //    exist because the user exported them in their shell are left untouched —
  //    we only manage values that came from settings.env.
  for (const [key, value] of Object.entries(envPatch)) {
    if (value === undefined) {
      if (previousSettingsEnv[key] !== undefined) {
        delete process.env[key]
      }
    } else {
      process.env[key] = value
    }
  }

  return { error: null, envPatch }
}

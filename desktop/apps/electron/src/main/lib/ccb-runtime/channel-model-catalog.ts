import type { AgentRuntimeModelCatalog, Channel } from '@proma/shared'
import { buildLocalCliProviderConfiguration } from '../local-service/provider-configuration'
import { buildFallbackModelCatalog } from './model-catalog-fallback'

/**
 * 在 CLI Session 尚未初始化时，由当前渠道的显式配置构建离线目录。
 *
 * 这里只读取模型元数据，不解析凭证、不访问 Provider，也不推测 Runtime 能力。
 * Session 初始化后，model-catalog-service 会用 CLI initialize.models 替换该目录。
 */
export function buildChannelModelCatalog(
  channel: Channel,
  defaultModel?: string,
  includeDisabledModels = false,
): AgentRuntimeModelCatalog {
  const providerConfiguration = buildLocalCliProviderConfiguration(
    channel,
    defaultModel,
    { includeDisabledModels },
  )
  return buildFallbackModelCatalog(channel.id, providerConfiguration)
}

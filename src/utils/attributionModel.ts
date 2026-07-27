import { getMainLoopModel } from './model/model.js'
import { resolveProviderModelId } from './model/providerModel.js'

export function getRealModelName(): string {
  return resolveProviderModelId(getMainLoopModel())
}

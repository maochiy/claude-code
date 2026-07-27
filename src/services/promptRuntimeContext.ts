import { getDisplayedEffortLevel } from '../utils/effort.js'
import { getMainLoopModel } from '../utils/model/model.js'

export interface PromptRuntimeContext {
  model: string
  effort: string
  cwd: string
}

export function resolvePromptRuntimeContext(): PromptRuntimeContext {
  const model = getMainLoopModel()
  return {
    model,
    effort: getDisplayedEffortLevel(model, undefined),
    cwd: process.cwd(),
  }
}

import { getSdkBetas } from '../../bootstrap/state.js'
import type { Message } from '../../types/message.js'
import { getContextWindowForModel } from '../../utils/context.js'
import {
  getDefaultMainLoopModelSetting,
  type ModelSetting,
  parseUserSpecifiedModel,
  renderDefaultModelSetting,
} from '../../utils/model/model.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'

type ModelSwitchCheck = { allowed: true } | { allowed: false; message: string }

export function checkModelSwitchCapacity(
  model: ModelSetting,
  messages: readonly Message[],
): ModelSwitchCheck {
  const resolvedModel = parseUserSpecifiedModel(
    model ?? getDefaultMainLoopModelSetting(),
  )
  const targetCapacity = getContextWindowForModel(resolvedModel, getSdkBetas())
  const currentUsage = tokenCountWithEstimation(
    getMessagesAfterCompactBoundary([...messages]),
  )

  if (currentUsage <= targetCapacity) {
    return { allowed: true }
  }

  const targetLabel = renderDefaultModelSetting(
    model ?? getDefaultMainLoopModelSetting(),
  )
  return {
    allowed: false,
    message: `Cannot switch to ${targetLabel} because the current context uses approximately ${currentUsage.toLocaleString()} tokens, exceeding its ${targetCapacity.toLocaleString()}-token context window. Run /compact manually, then try again.`,
  }
}

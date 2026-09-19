export interface PlanDocument {
  id: string
  content: string
  /** Runtime 明确提供的计划源文件路径；没有真实字段时不得推断。 */
  sourcePath?: string
}

export interface ExtractPlanDocumentOptions {
  planMode?: boolean
}

interface MessageEntry {
  value: Record<string, unknown>
  index: number
}

interface BlockEntry {
  block: Record<string, unknown>
  blockIndex: number
  message: MessageEntry
}

const STRUCTURED_PLAN_TYPES = new Set([
  'plan',
  'proposed_plan',
  'plan_proposal',
  'proposed-plan',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  return value
}

function explicitPlanSourcePath(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined
  return nonEmptyString(value.sourcePath)
    ?? nonEmptyString(value.source_path)
    ?? nonEmptyString(value.filePath)
    ?? nonEmptyString(value.file_path)
    ?? nonEmptyString(value.planPath)
    ?? nonEmptyString(value.plan_path)
}

function messageIdentity(message: MessageEntry): string {
  const messageBody = isRecord(message.value.message) ? message.value.message : undefined
  return nonEmptyString(messageBody?.id)
    ?? nonEmptyString(message.value.uuid)
    ?? `message-${message.index}`
}

function isTopLevelAssistant(message: MessageEntry): boolean {
  return message.value.type === 'assistant'
    && message.value.parent_tool_use_id == null
    && message.value.isReplay !== true
    && message.value.error == null
}

function getAssistantBlocks(message: MessageEntry): Record<string, unknown>[] {
  if (!isTopLevelAssistant(message)) return []
  const body = isRecord(message.value.message) ? message.value.message : undefined
  if (!Array.isArray(body?.content)) return []
  return body.content.filter(isRecord)
}

function isHumanUserMessage(message: MessageEntry): boolean {
  if (message.value.type !== 'user' || message.value.parent_tool_use_id != null) return false
  if (message.value.isReplay === true || message.value.isSynthetic === true) return false
  const body = isRecord(message.value.message) ? message.value.message : undefined
  if (nonEmptyString(body?.content)) return true
  if (!Array.isArray(body?.content)) return false
  return body.content.some((block) => (
    isRecord(block)
    && block.type !== 'tool_result'
  ))
}

function splitIntoTurns(messages: readonly unknown[]): MessageEntry[][] {
  const turns: MessageEntry[][] = [[]]
  messages.forEach((value, index) => {
    if (!isRecord(value)) return
    const entry = { value, index }
    if (isHumanUserMessage(entry) && turns.at(-1)?.length) turns.push([])
    turns.at(-1)?.push(entry)
  })
  return turns.filter((turn) => turn.length > 0)
}

function assistantBlocks(turn: MessageEntry[]): BlockEntry[] {
  return turn.flatMap((message) => getAssistantBlocks(message).map((block, blockIndex) => ({
    block,
    blockIndex,
    message,
  })))
}

function structuredPlan(turn: MessageEntry[]): PlanDocument | undefined {
  const blocks = assistantBlocks(turn)
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const entry = blocks[index]!
    if (!STRUCTURED_PLAN_TYPES.has(String(entry.block.type))) continue
    const content = nonEmptyString(entry.block.content) ?? nonEmptyString(entry.block.text)
    if (!content) continue
    return {
      id: `${messageIdentity(entry.message)}:plan:${entry.blockIndex}`,
      content,
      ...(explicitPlanSourcePath(entry.block) && {
        sourcePath: explicitPlanSourcePath(entry.block),
      }),
    }
  }
  return undefined
}

function exitPlanDocument(turn: MessageEntry[]): PlanDocument | undefined {
  const blocks = assistantBlocks(turn)
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const entry = blocks[index]!
    if (entry.block.type !== 'tool_use' || entry.block.name !== 'ExitPlanMode') continue

    const input = isRecord(entry.block.input) ? entry.block.input : undefined
    const explicitPlan = nonEmptyString(input?.plan)
    const toolId = nonEmptyString(entry.block.id)
      ?? `${messageIdentity(entry.message)}:${entry.blockIndex}`
    if (explicitPlan) {
      return {
        id: `exit-plan:${toolId}`,
        content: explicitPlan,
        ...(explicitPlanSourcePath(input) && { sourcePath: explicitPlanSourcePath(input) }),
      }
    }

    const precedingText: string[] = []
    for (let precedingIndex = index - 1; precedingIndex >= 0; precedingIndex -= 1) {
      const preceding = blocks[precedingIndex]!
      if (preceding.block.type !== 'text') break
      const text = nonEmptyString(preceding.block.text)
      if (!text) break
      precedingText.unshift(text)
    }
    if (precedingText.length > 0) {
      return {
        id: `exit-plan:${toolId}`,
        content: precedingText.join('\n\n'),
        ...(explicitPlanSourcePath(input) && { sourcePath: explicitPlanSourcePath(input) }),
      }
    }
  }
  return undefined
}

function completedPlanModeDocument(
  turn: MessageEntry[],
  persistedPlanMode: boolean,
): PlanDocument | undefined {
  const allBlocks = assistantBlocks(turn)
  const blocks = persistedPlanMode
    ? allBlocks.filter((entry) => entry.message.value._promaPlanMode === true)
    : allBlocks
  if (blocks.length === 0) return undefined

  const lastToolIndex = blocks.findLastIndex((entry) => entry.block.type === 'tool_use')
  const finalTextBlocks = blocks.filter((entry, index) => (
    index > lastToolIndex
    && entry.block.type === 'text'
    && nonEmptyString(entry.block.text) != null
    && entry.message.value._partial !== true
  ))
  if (finalTextBlocks.length === 0) return undefined

  const lastText = finalTextBlocks.at(-1)!
  const latestAssistant = [...turn].reverse().find(isTopLevelAssistant)
  const latestPlanAssistant = persistedPlanMode
    ? [...turn].reverse().find((message) => (
        isTopLevelAssistant(message)
        && message.value._promaPlanMode === true
      ))
    : latestAssistant
  const hasExplicitFinalPhase = latestPlanAssistant === lastText.message
    && latestPlanAssistant.value._promaActivityPhase === 'idle'
    && latestPlanAssistant.value._partial !== true
  const lastTextMessageIndex = lastText.message.index
  const nextNonPlanAssistantIndex = persistedPlanMode
    ? turn.find((message) => (
        message.index > lastTextMessageIndex
        && isTopLevelAssistant(message)
        && message.value._promaPlanMode === false
      ))?.index
    : undefined
  const terminalResults = turn.filter((message) => (
    message.index > lastTextMessageIndex
    && (nextNonPlanAssistantIndex == null || message.index < nextNonPlanAssistantIndex)
    && message.value.type === 'result'
    && message.value.isSyntheticCompactionResult !== true
  ))
  const lastTerminalResult = terminalResults.at(-1)
  const hasSuccessfulResult = lastTerminalResult?.value.subtype === 'success'
  if (lastTerminalResult && !hasSuccessfulResult) return undefined
  if (!lastTerminalResult && !hasExplicitFinalPhase) return undefined

  const firstText = finalTextBlocks[0]!
  return {
    id: `${messageIdentity(firstText.message)}:plan-final:${firstText.blockIndex}`,
    content: finalTextBlocks.map((entry) => String(entry.block.text)).join('\n\n'),
  }
}

/**
 * 从 Runtime 无关的消息投影中提取最近一轮可靠计划正文。
 *
 * 普通 assistant 正文只有在当前明确处于计划模式，且本轮已经成功结束或
 * Runtime 明确标记为 final/idle 时才会被采用，避免把工具前过程说明当成计划。
 */
export function extractPlanDocument(
  messages: readonly unknown[],
  options: ExtractPlanDocumentOptions = {},
): PlanDocument | undefined {
  const turns = splitIntoTurns(messages)
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex]!
    const document = structuredPlan(turn) ?? exitPlanDocument(turn)
    if (document) return document
    const blocks = assistantBlocks(turn)
    const persistedPlanMode = blocks.some(
      (entry) => entry.message.value._promaPlanMode === true,
    )
    const hasPlanModeAnnotation = blocks.some(
      (entry) => typeof entry.message.value._promaPlanMode === 'boolean',
    )
    const livePlanMode = options.planMode
      && turnIndex === turns.length - 1
      && !hasPlanModeAnnotation
    if (persistedPlanMode || livePlanMode) {
      return completedPlanModeDocument(turn, persistedPlanMode)
    }
  }
  return undefined
}

export type PlanDocumentStage = 'document' | 'proposed' | 'approved' | 'changes_requested' | 'rejected'

/** 只有匹配同一个 ExitPlanMode 工具的结构化结算才能改变计划阶段。 */
export function getPlanDocumentStage(messages: readonly unknown[], document: PlanDocument): PlanDocumentStage {
  if (!document.id.startsWith('exit-plan:')) return 'document'
  const toolUseId = document.id.slice('exit-plan:'.length)
  let stage: PlanDocumentStage = 'proposed'
  for (const message of messages) {
    if (!isRecord(message) || message.type !== 'system' || message.subtype !== 'interaction_settled') continue
    const settlement = message.settlement
    if (!isRecord(settlement) || settlement.kind !== 'exit_plan' || settlement.toolUseId !== toolUseId) continue
    if (settlement.outcome === 'approved') stage = 'approved'
    else if (settlement.outcome === 'feedback') stage = 'changes_requested'
    else if (settlement.outcome === 'denied') stage = 'rejected'
  }
  return stage
}

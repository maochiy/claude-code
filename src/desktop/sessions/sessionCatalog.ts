import type { UUID } from 'node:crypto'
import { rm, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import type { Message } from '../../types/message.js'
import { setOriginalCwd } from '../../bootstrap/state.js'
import {
  getLastSessionLog,
  getSessionMessagesCache,
} from '../../utils/sessionStorage.js'
import { resolveSessionFilePath } from '../../utils/sessionStoragePortable.js'
import { listSessionsImpl } from '../../utils/listSessionsImpl.js'
import { toSDKMessages } from '../../utils/messages/mappers.js'
import { applyDesktopRuntimeConfiguration } from '../bootstrap/runtimeConfiguration.js'
import type {
  RuntimeEnvironment,
  RuntimeSessionCatalog,
  RuntimeSessionTranscript,
} from '../protocol/types.js'

function prepareSessionCatalogEnvironment(
  cwd: string,
  environment: RuntimeEnvironment,
): string {
  const resolvedCwd = resolve(cwd)
  applyDesktopRuntimeConfiguration(environment)
  setOriginalCwd(resolvedCwd)
  process.chdir(resolvedCwd)
  return resolvedCwd
}

function toSdkMessages(
  messages: Message[] | undefined,
  runtimeSessionId: string,
): SDKMessage[] {
  if (!messages) return []
  return toSDKMessages(messages).map(message => ({
    ...message,
    session_id: runtimeSessionId,
  }))
}

export async function resolveDesktopSessionCatalog(input: {
  cwd: string
  environment: RuntimeEnvironment
  limit?: number
  offset?: number
}): Promise<RuntimeSessionCatalog> {
  const cwd = prepareSessionCatalogEnvironment(input.cwd, input.environment)
  const sessions = await listSessionsImpl({
    dir: cwd,
    limit: input.limit,
    offset: input.offset,
    includeWorktrees: true,
  })
  return {
    cwd,
    sessions: sessions.map(session => ({
      runtimeSessionId: session.sessionId,
      title: session.customTitle ?? session.summary,
      summary: session.summary,
      cwd: session.cwd ?? cwd,
      createdAt: session.createdAt,
      updatedAt: session.lastModified,
      gitBranch: session.gitBranch,
      tag: session.tag,
    })),
    ...(input.limit && sessions.length === input.limit
      ? { nextOffset: (input.offset ?? 0) + sessions.length }
      : {}),
  }
}

export async function resolveDesktopSessionTranscript(input: {
  cwd: string
  environment: RuntimeEnvironment
  runtimeSessionId: string
}): Promise<RuntimeSessionTranscript> {
  const cwd = prepareSessionCatalogEnvironment(input.cwd, input.environment)
  const recovered = await getLastSessionLog(input.runtimeSessionId as UUID)
  if (!recovered) {
    throw new Error(`未找到 CCB Session: ${input.runtimeSessionId}`)
  }
  return {
    runtimeSessionId: input.runtimeSessionId,
    cwd,
    messages: toSdkMessages(
      recovered.messages,
      recovered.sessionId ?? input.runtimeSessionId,
    ),
  }
}

/**
 * 删除 CCB 原生 Transcript 及其同名会话附属目录。
 *
 * 该操作保持幂等：目标已不存在时仍视为成功。路径解析限定在传入 cwd
 * 对应的项目目录及其 worktree，避免仅凭 Session ID 跨项目误删。
 */
export async function deleteDesktopSession(input: {
  cwd: string
  environment: RuntimeEnvironment
  runtimeSessionId: string
}): Promise<{ deleted: boolean }> {
  const cwd = prepareSessionCatalogEnvironment(input.cwd, input.environment)
  const resolved = await resolveSessionFilePath(input.runtimeSessionId, cwd)
  if (!resolved) return { deleted: false }

  try {
    await unlink(resolved.filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  // Subagent、Workflow、Remote Agent 等附属数据位于 <sessionId>/ 目录。
  await rm(join(dirname(resolved.filePath), input.runtimeSessionId), {
    recursive: true,
    force: true,
  })
  getSessionMessagesCache().delete(input.runtimeSessionId as UUID)
  return { deleted: true }
}

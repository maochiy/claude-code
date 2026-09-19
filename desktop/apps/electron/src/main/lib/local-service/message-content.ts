import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentMessageAttachment } from '@proma/shared'
import { MAX_ATTACHMENT_SIZE } from '@proma/shared'
import { getMimeType, isImageAttachment } from '../attachment-service'

export interface BuildAgentMessageContentInput {
  text: string
  attachments?: AgentMessageAttachment[]
  /** 当前会话私有附件目录。目录内图片可直接读取。 */
  sessionAttachmentDirectory: string
  /** 用户已经通过会话/工作区附加动作明确授权的单个文件。 */
  allowedAttachmentFiles?: string[]
}

export type AgentCliMessageContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: {
        type: 'base64'
        media_type: string
        data: string
      }
    }

function canonicalPath(path: string): string {
  return realpathSync(resolve(path))
}

function isPathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (
    !isAbsolute(child)
    && child !== '..'
    && !child.startsWith(`..${sep}`)
  )
}

function resolveAllowedAttachmentPath(
  localPath: string,
  sessionAttachmentDirectory: string,
  allowedAttachmentFiles: readonly string[],
): string {
  if (!isAbsolute(localPath)) {
    throw new Error('Agent 图片附件必须使用绝对路径')
  }
  const candidate = canonicalPath(localPath)
  const sessionDirectory = (() => {
    try {
      return canonicalPath(sessionAttachmentDirectory)
    } catch {
      return resolve(sessionAttachmentDirectory)
    }
  })()
  if (isPathInside(sessionDirectory, candidate)) return candidate

  const explicitlyAllowed = allowedAttachmentFiles.some((file) => {
    try {
      return canonicalPath(file) === candidate
    } catch {
      return false
    }
  })
  if (!explicitlyAllowed) {
    throw new Error('Agent 图片附件路径不在当前会话允许范围内')
  }
  return candidate
}

/**
 * 把本轮用户明确附加的图片转换为 CLI 原生 content blocks。
 *
 * 文件路径先按会话私有附件目录或已持久化的单文件授权做 realpath 校验，
 * 防止模型文本或软链接把任意本机文件当成图片读取。
 */
export function buildAgentMessageContent(
  input: BuildAgentMessageContentInput,
): AgentCliMessageContentBlock[] | undefined {
  const images = input.attachments?.filter(attachment => isImageAttachment(attachment.mediaType)) ?? []
  if (images.length === 0) return undefined

  const blocks: AgentCliMessageContentBlock[] = [{ type: 'text', text: input.text }]
  const seen = new Set<string>()
  for (const attachment of images) {
    const filePath = resolveAllowedAttachmentPath(
      attachment.localPath,
      input.sessionAttachmentDirectory,
      input.allowedAttachmentFiles ?? [],
    )
    if (seen.has(filePath)) continue
    seen.add(filePath)

    const detectedMediaType = getMimeType(extname(filePath))
    if (!isImageAttachment(detectedMediaType)) {
      throw new Error(`附件 ${attachment.filename} 不是支持的图片格式`)
    }
    const size = statSync(filePath).size
    if (size > MAX_ATTACHMENT_SIZE) {
      throw new Error(`图片 ${attachment.filename} 超过大小限制`)
    }
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: detectedMediaType,
        data: readFileSync(filePath).toString('base64'),
      },
    })
  }
  return blocks.length > 1 ? blocks : undefined
}

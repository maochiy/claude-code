/**
 * Browser* 工具共享层：后端单例 + 会话作用域解析 + 统一输出映射。
 *
 * 后端与 socket client 来自 @claude-code-best/browser-use（native messaging 链路，
 * 详见 packages/browser-use/README.md）。测试通过 setBrowserBackendForTests 注入
 * 内存 fake，不要 mock.module 业务模块。
 */
import { BrowserBackend, getBrowserClient } from '@claude-code-best/browser-use'
import type { ToolResultBlockParam, ToolUseContext } from 'src/Tool.js'
import { getSessionId } from 'src/bootstrap/state.js'
import type { Message } from 'src/types/message.js'
import { ensureBrowserNativeHostInstalled } from 'src/utils/browserUse/setup.js'

export type BrowserToolOutput =
  | { kind: 'data'; data: Record<string, unknown> }
  | { kind: 'list'; items: Record<string, unknown>[] }
  | { kind: 'image'; text: string; base64: string; mediaType: string }

let backendInstance: BrowserBackend | null = null

/** 会话侧共享后端（TaskRegistry 按 sessionId 隔离，多会话/子代理各拿各的标签组）。 */
export function getBrowserBackend(): BrowserBackend {
  if (!backendInstance) {
    backendInstance = new BrowserBackend({ client: getBrowserClient() })
  }
  return backendInstance
}

/** 仅供测试替换后端实现；传 null 恢复默认单例。 */
export function setBrowserBackendForTests(
  backend: BrowserBackend | null,
): void {
  backendInstance = backend
}

let installStarted = false

/** 首次使用浏览器时幂等安装 native host（fire-and-forget，不阻塞请求）。 */
export function kickOffNativeHostInstall(): void {
  if (installStarted) return
  installStarted = true
  // 测试环境不触碰真实文件系统（与 dsh 实现同款守卫）
  if (process.env.NODE_ENV === 'test') return
  void ensureBrowserNativeHostInstalled().catch(() => {})
}

/** 首条用户消息文本（截 60 字符），用作 Chrome 标签组名。 */
function firstUserMessageText(messages: Message[]): string {
  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = message.message?.content
    if (content == null) continue
    const text =
      typeof content === 'string'
        ? content
        : content
            .map(block => (block.type === 'text' ? block.text : ''))
            .join(' ')
    const cleaned = text.replace(/\s+/g, ' ').trim()
    if (cleaned) return cleaned.slice(0, 60)
  }
  return ''
}

/**
 * 解析浏览器作用域：sessionId 区分会话标签组（子代理各有各的），sessionTitle
 * 是 Chrome 标签组名（首条用户消息 → 会话 <id 前 8 位>）。
 *
 * 注意：不从 sessionStorage 取 /rename 标题——它 import commands.js，会把整个
 * 命令注册表循环拖进 builtin-tools。
 */
export function resolveBrowserScope(context: ToolUseContext): {
  sessionId: string
  sessionTitle: string
} {
  const sessionId = String(context.agentId ?? getSessionId())
  const sessionTitle =
    firstUserMessageText(context.messages) || `会话 ${sessionId.slice(0, 8)}`
  return { sessionId, sessionTitle }
}

/** 统一输出映射：普通结果序列化为 JSON，截图产出 text + image 块。 */
export function mapBrowserOutput(
  output: BrowserToolOutput,
  toolUseID: string,
): ToolResultBlockParam {
  if (output.kind === 'image') {
    const allowedMediaTypes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ] as const
    const mediaType: (typeof allowedMediaTypes)[number] = (
      allowedMediaTypes as readonly string[]
    ).includes(output.mediaType)
      ? (output.mediaType as (typeof allowedMediaTypes)[number])
      : 'image/jpeg'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        { type: 'text', text: output.text },
        {
          type: 'image',
          source: {
            type: 'base64',
            data: output.base64,
            media_type: mediaType,
          },
        },
      ],
    }
  }
  const body = output.kind === 'list' ? output.items : output.data
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: JSON.stringify(body, null, 2),
  }
}

/** Browser* 工具标准流程提示（dsh SKILL.md 的移植）。 */
export const BROWSER_WORKFLOW_PROMPT = `
标准流程：
1. BrowserNavigate 打开 URL（或 BrowserAttach 附加已有标签）
2. BrowserGetState 获取页面状态与可交互元素 ref
3. 用 ref 执行 BrowserClick / BrowserType / BrowserPress / BrowserScroll
4. BrowserGetState 或 BrowserScreenshot 核对结果
5. 结束后 BrowserClose 清理（插件创建的后台标签会被关闭）

ref 在页面导航后会失效，操作报 ref 不存在时先重新 BrowserGetState。
所有操作都在后台标签执行，不会切换用户正在看的页面；涉及登录、支付、
发送等敏感操作前先向用户确认。`.trim()

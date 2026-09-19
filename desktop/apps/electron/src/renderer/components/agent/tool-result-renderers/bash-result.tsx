/**
 * Bash 工具结果渲染器 — 终端风格
 *
 * 主题自适应背景、等宽字体、stderr 红色高亮
 */

import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { highlightToTokens } from '@proma/core'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/i18n'

interface BashResultRendererProps {
  result: string
  isError: boolean
  input: Record<string, unknown>
}

/** 简单检测 stderr 行（常见模式） */
function classifyLine(line: string): 'stderr' | 'normal' {
  const lower = line.toLowerCase()
  if (
    lower.startsWith('error:') ||
    lower.startsWith('error ') ||
    lower.startsWith('fatal:') ||
    lower.startsWith('warning:') ||
    lower.includes('traceback') ||
    lower.includes('exception') ||
    lower.startsWith('stderr:')
  ) {
    return 'stderr'
  }
  return 'normal'
}

export function BashResultRenderer({ result, isError, input }: BashResultRendererProps): React.ReactElement {
  const { language } = useTranslation()
  const [copied, setCopied] = React.useState(false)
  const command = typeof input.command === 'string' ? input.command : undefined
  const lines = result.split('\n')
  const highlightedCommand = React.useMemo(
    () => command ? highlightToTokens({ code: command, language: 'bash' }) : null,
    [command],
  )
  const hasOverflowFade = lines.length > 12 || result.length > 1_000

  const copyCommand = React.useCallback(async () => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2_000)
    } catch (error) {
      console.error('[BashResultRenderer] 复制命令失败:', error)
    }
  }, [command])

  return (
    <div className="space-y-2" data-bash-result>
      {command && (
        <div className="overflow-hidden rounded-md border border-border/50 bg-[hsl(var(--code-bg))]" data-bash-command>
          <div className="flex h-8 items-center justify-between bg-muted/60 px-2 text-xs text-muted-foreground">
            <span className="font-medium">Shell</span>
            <button type="button" onClick={copyCommand} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-foreground/10 hover:text-foreground">
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              <span>{language === 'zh' ? (copied ? '已复制' : '复制') : (copied ? 'Copied' : 'Copy')}</span>
            </button>
          </div>
          <pre className="m-0 overflow-x-auto p-3 font-mono text-[12px] leading-relaxed text-foreground/85">
            <code>
              <span className="select-none text-emerald-600 dark:text-emerald-400">$ </span>
              {(highlightedCommand?.lines ?? []).map((tokenLine, lineIndex) => (
                <React.Fragment key={lineIndex}>
                  {lineIndex > 0 && '\n'}
                  {tokenLine.map((token, tokenIndex) => (
                    <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>{token.content}</span>
                  ))}
                </React.Fragment>
              ))}
              {!highlightedCommand && command}
            </code>
          </pre>
        </div>
      )}
      <div className="relative">
        <div
          aria-label={language === 'zh' ? '终端输出' : 'Terminal output'}
          className={cn(
            'max-h-[300px] overflow-auto rounded-md bg-muted/50 p-3',
            'font-mono text-[12px] leading-relaxed text-foreground/85',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
          data-tool-output
          role="log"
          tabIndex={0}
        >
          {lines.map((line, index) => {
            const type = isError ? 'stderr' : classifyLine(line)
            return (
              <div
                key={index}
                className={cn(
                  'min-h-[1.25em] whitespace-pre-wrap break-all',
                  type === 'stderr' && 'text-destructive dark:text-red-400',
                )}
              >
                {line || '\u200B'}
              </div>
            )
          })}
        </div>
        {hasOverflowFade && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-md bg-gradient-to-t from-muted to-transparent" data-tool-output-fade />
        )}
      </div>
    </div>
  )
}

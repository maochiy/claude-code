import * as React from 'react'
import { Loader2, Wrench } from 'lucide-react'
import type { SDKSystemMessage } from '@proma/shared'
import { useTranslation } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface HookLifecycleFields {
  subtype: 'hook_started' | 'hook_progress' | 'hook_response'
  hookId: string
  hookName: string
  hookEvent: string
  outcome?: 'success' | 'error' | 'cancelled'
  exitCode?: number
  output?: string
  stdout?: string
  stderr?: string
}

function getHookLifecycleFields(message: SDKSystemMessage): HookLifecycleFields | null {
  const subtype = message.subtype
  if (subtype !== 'hook_started' && subtype !== 'hook_progress' && subtype !== 'hook_response') {
    return null
  }
  if (
    typeof message.hook_id !== 'string'
    || typeof message.hook_name !== 'string'
    || typeof message.hook_event !== 'string'
  ) return null
  const outcome = message.outcome === 'success'
    || message.outcome === 'error'
    || message.outcome === 'cancelled'
    ? message.outcome
    : undefined
  if (subtype === 'hook_response' && outcome === undefined) return null
  return {
    subtype,
    hookId: message.hook_id,
    hookName: message.hook_name,
    hookEvent: message.hook_event,
    outcome,
    exitCode: typeof message.exit_code === 'number' ? message.exit_code : undefined,
    output: typeof message.output === 'string' && message.output.length > 0 ? message.output : undefined,
    stdout: typeof message.stdout === 'string' && message.stdout.length > 0 ? message.stdout : undefined,
    stderr: typeof message.stderr === 'string' && message.stderr.length > 0 ? message.stderr : undefined,
  }
}

/** 忠实展示原生 CLI 上报的 Hook 生命周期与输出，不从正文推断状态。 */
export function HookLifecycleNotice({ message }: { message: SDKSystemMessage }): React.ReactElement | null {
  const { language } = useTranslation()
  const fields = getHookLifecycleFields(message)
  if (!fields) return null

  const running = fields.subtype !== 'hook_response'
  const labels = language === 'zh'
    ? {
        started: 'Hook 已启动', progress: 'Hook 执行中', success: 'Hook 已完成',
        error: 'Hook 执行失败', cancelled: 'Hook 已取消', details: '查看 Hook 输出',
        output: '输出', stdout: '标准输出', stderr: '标准错误', exitCode: '退出码',
      }
    : {
        started: 'Hook started', progress: 'Hook running', success: 'Hook completed',
        error: 'Hook failed', cancelled: 'Hook cancelled', details: 'View hook output',
        output: 'Output', stdout: 'Standard output', stderr: 'Standard error', exitCode: 'Exit code',
      }
  const status = fields.subtype === 'hook_started'
    ? 'started'
    : fields.subtype === 'hook_progress'
      ? 'progress'
      : fields.outcome!
  const tone = status === 'success'
    ? 'text-emerald-600 dark:text-emerald-400'
    : status === 'error' || status === 'cancelled'
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-muted-foreground'
  const sections = [
    fields.output ? { label: labels.output, value: fields.output } : undefined,
    fields.stdout && fields.stdout !== fields.output ? { label: labels.stdout, value: fields.stdout } : undefined,
    fields.stderr && fields.stderr !== fields.output && fields.stderr !== fields.stdout
      ? { label: labels.stderr, value: fields.stderr }
      : undefined,
  ].filter((section): section is { label: string; value: string } => section !== undefined)

  return (
    <div className="my-1.5 min-w-0 pl-8 text-xs" data-agent-hook-event={fields.subtype} data-hook-id={fields.hookId}>
      <div className="flex min-w-0 items-start gap-2">
        {running
          ? <Loader2 className={cn('mt-0.5 size-3.5 shrink-0 animate-spin', tone)} />
          : <Wrench className={cn('mt-0.5 size-3.5 shrink-0', tone)} />}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn('font-medium', tone)}>{labels[status]}</span>
            <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-foreground/80">{fields.hookName}</code>
            <span className="text-muted-foreground/70">{fields.hookEvent}</span>
            {fields.exitCode != null && <span className="text-muted-foreground/70">{labels.exitCode} {fields.exitCode}</span>}
          </div>
          {sections.length > 0 && (
            <details className="group max-w-3xl">
              <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">{labels.details}</summary>
              <div className="mt-1.5 max-h-64 space-y-2 overflow-auto rounded-md bg-muted/50 p-2.5">
                {sections.map((section) => (
                  <div key={section.label} className="space-y-1">
                    <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{section.label}</div>
                    <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/80">{section.value}</pre>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}

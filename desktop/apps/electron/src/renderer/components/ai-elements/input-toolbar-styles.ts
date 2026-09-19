export const inputAreaContainerClass =
  'transcript-width-column mx-auto w-full px-5 pb-4 sm:px-8'

export const inputAreaFadeClass =
  'before:pointer-events-none before:absolute before:-inset-x-5 before:-top-8 before:-z-10 before:h-12 before:bg-gradient-to-t before:from-content-area before:via-content-area/85 before:to-transparent'

export const inputCardClass =
  'input-surface-card !rounded-[22px] border border-black/[0.08] bg-[hsl(var(--input-surface))] shadow-[0_4px_16px_-10px_rgba(15,23,42,0.24),0_1px_3px_rgba(15,23,42,0.04)] transition-[border-color,box-shadow] duration-150 focus-within:border-black/[0.13] focus-within:shadow-[0_6px_20px_-10px_rgba(15,23,42,0.28),0_2px_5px_rgba(15,23,42,0.05)] dark:border-white/[0.10] dark:shadow-[0_7px_24px_-14px_rgba(0,0,0,0.72)] dark:focus-within:border-white/[0.16] dark:focus-within:shadow-[0_9px_28px_-14px_rgba(0,0,0,0.78)]'

export const inputToolbarButtonClass =
  'size-7 shrink-0 rounded-md text-foreground/55 hover:text-foreground hover:bg-muted/55 data-[state=open]:bg-muted/55 data-[state=open]:text-foreground'

export const inputToolbarActiveButtonClass =
  '!bg-transparent text-primary shadow-none hover:!bg-transparent hover:text-primary data-[state=open]:!bg-transparent [&_svg]:stroke-[2.75]'

export const inputToolbarDangerButtonClass =
  'size-8 shrink-0 rounded-full !bg-foreground !text-background shadow-sm hover:!bg-foreground/88 hover:!text-background'

export const inputToolbarSendButtonClass =
  'size-8 shrink-0 rounded-full !bg-foreground !text-background shadow-sm hover:!bg-foreground/88 hover:!text-background'

export const inputToolbarDisabledButtonClass =
  'size-8 shrink-0 rounded-full !bg-muted !text-muted-foreground/45 shadow-none cursor-not-allowed'

/** 会话模式使用单行起步的紧凑输入框，内宽与消息正文保持 768px。 */
export const agentInputAreaContainerClass =
  'agent-transcript-width-column mx-auto w-full px-5 pb-1 sm:px-8'

export const agentInputCardClass =
  'input-surface-card rounded-xl border border-foreground/[0.12] bg-[hsl(var(--input-surface))] shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-foreground/25 focus-within:shadow-md'

/**
 * 设置模态框共享控件
 *
 * 图 8 样式的设置行 / 分段控件 / 开关：
 * - 行：左侧标题（14px）+ 描述（13px muted），右侧控件
 * - 分段控件：浅灰容器 + 选中项白底浮起，中性配色
 * - 开关：无彩色填充，选中态使用前景色轨道
 */

import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'

interface ModalSettingRowProps {
  label: string
  description?: string
  children?: React.ReactNode
}

/** 模态框内的标准设置行 */
export function ModalSettingRow({ label, description, children }: ModalSettingRowProps): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5">
      <div className="min-w-0">
        <div className="text-[14px] text-foreground">{label}</div>
        {description !== undefined && (
          <div className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{description}</div>
        )}
      </div>
      {children !== undefined && <div className="shrink-0">{children}</div>}
    </div>
  )
}

interface ModalSegmentedOption<T extends string> {
  value: T
  label: string
}

interface ModalSegmentedProps<T extends string> {
  value: T
  options: ModalSegmentedOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
}

/** 中性分段控件：容器浅灰，选中项白底浮起 */
export function ModalSegmented<T extends string>({ value, options, onChange, ariaLabel }: ModalSegmentedProps<T>): React.ReactElement {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex items-center gap-0.5 rounded-lg bg-foreground/[0.06] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-[7px] px-3 py-1 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45',
            value === option.value
              ? 'bg-background font-medium text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

interface ModalSwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  ariaLabel: string
}

/** 中性开关：轨道无彩色填充，选中态为前景色 */
export function ModalSwitch({ checked, onCheckedChange, ariaLabel }: ModalSwitchProps): React.ReactElement {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={ariaLabel}
      className={cn(
        'relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45',
        checked ? 'bg-foreground' : 'bg-foreground/[0.18]',
      )}
    >
      <SwitchPrimitive.Thumb className="block size-[18px] translate-x-[2px] rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  )
}

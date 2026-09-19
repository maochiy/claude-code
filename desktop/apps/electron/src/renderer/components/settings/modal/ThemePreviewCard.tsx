/**
 * 图 8 主题预览卡
 *
 * 344×162 卡片内嵌一个固定配色的 4 行 TypeScript diff 预览。
 * 预览内部使用截图原色（不随主题 token 变化），保证与参考图 1:1；
 * 卡片外框 / 标签使用主题 token，适配明暗模式。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

/** 浅色预览配色（截图原色） */
const LIGHT_PALETTE = {
  bg: '#FDFDFC',
  text: '#403E3A',
  lineNumber: '#9B9A95',
  keyword: '#8E6BD9',
  functionName: '#C86E2C',
  string: '#1E9E3C',
  deletionRow: '#FFE9E2',
  deletionWord: '#FFCFC7',
  deletionText: '#FF4B41',
  additionRow: '#E5F2E4',
  additionWord: '#C7E5CB',
  additionText: '#1E9E3C',
} as const

/** 深色预览配色（截图原色） */
const DARK_PALETTE = {
  bg: '#151515',
  text: '#D9D8D5',
  lineNumber: '#6E6C68',
  keyword: '#B796FF',
  functionName: '#E97E2E',
  string: '#32D74B',
  deletionRow: '#502F29',
  deletionWord: '#73312A',
  deletionText: '#FF8A80',
  additionRow: '#31462F',
  additionWord: '#316335',
  additionText: '#32D74B',
} as const

interface ThemePreviewCardProps {
  /** 卡片顶部标签（Light / Dark） */
  label: string
  dark: boolean
  selected: boolean
  onSelect: () => void
}

export function ThemePreviewCard({ label, dark, selected, onSelect }: ThemePreviewCardProps): React.ReactElement {
  const palette = dark ? DARK_PALETTE : LIGHT_PALETTE
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex h-[162px] flex-col rounded-[10px] border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45',
        selected
          ? 'border-foreground/60 ring-1 ring-foreground/60'
          : 'border-border hover:border-foreground/25',
      )}
    >
      <div className="pb-2 text-[13px] text-foreground">{label}</div>
      <div
        data-theme-preview-code
        className="flex-1 overflow-hidden rounded-md px-2.5 py-2 font-mono text-[12px] leading-[21px]"
        style={{ background: palette.bg, color: palette.text }}
      >
        <div>
          <span style={{ color: palette.lineNumber }}>1&nbsp;&nbsp;</span>
          <span style={{ color: palette.keyword }}>function</span>
          {' '}
          <span style={{ color: palette.functionName }}>greet</span>
          (name:{' '}
          <span style={{ color: palette.string }}>string</span>) {'{'}
        </div>
        <div style={{ background: palette.deletionRow }}>
          <span style={{ color: palette.lineNumber }}>2&nbsp;&nbsp;</span>
          return{' '}
          <span style={{ background: palette.deletionWord, color: palette.deletionText }}>"Hello, "</span>
          {' '}
          <span style={{ color: palette.deletionText }}>+ name;</span>
        </div>
        <div style={{ background: palette.additionRow }}>
          <span style={{ color: palette.lineNumber }}>3&nbsp;&nbsp;</span>
          return{' '}
          <span style={{ background: palette.additionWord, color: palette.additionText }}>`Hello, {'${'}name{'}'}!`</span>;
        </div>
        <div>
          <span style={{ color: palette.lineNumber }}>4&nbsp;&nbsp;</span>
          {'}'}
        </div>
      </div>
    </button>
  )
}

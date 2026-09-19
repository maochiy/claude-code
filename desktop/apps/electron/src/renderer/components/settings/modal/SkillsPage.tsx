/**
 * SkillsPage - 设置模态框 Skills 页（对齐参考截图）
 *
 * 表格列出所有工作区的 Skill：Skill / Last updated / Author，
 * 顶部右侧搜索 + Add 下拉（从其他工作区导入）。
 */

import * as React from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentWorkspace, OtherWorkspaceSkillsGroup, SkillMeta } from '@proma/shared'
import { useTranslation } from '@/lib/i18n'

interface SkillRow {
  key: string
  name: string
  slug: string
  workspaceName: string
  workspaceSlug: string
  updatedAt?: number
}

/** 格式化更新时间为 M/D/YY（参考截图格式） */
function formatUpdatedAt(timestamp?: number): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear()).slice(2)}`
}

export function SkillsPage(): React.ReactElement {
  const { t } = useTranslation()
  const [rows, setRows] = React.useState<SkillRow[]>([])
  const [loaded, setLoaded] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [addMenuOpen, setAddMenuOpen] = React.useState(false)
  const [importSources, setImportSources] = React.useState<OtherWorkspaceSkillsGroup[]>([])
  const addMenuRef = React.useRef<HTMLDivElement>(null)

  // 汇总所有工作区的 Skill
  const load = React.useCallback(async (): Promise<void> => {
    try {
      const workspaces: AgentWorkspace[] = await window.electronAPI.listAgentWorkspaces()
      const groups = await Promise.all(
        workspaces.map(async (workspace) => {
          const skills: SkillMeta[] = await window.electronAPI.getWorkspaceSkills(workspace.slug).catch(() => [])
          return skills.map((skill): SkillRow => ({
            key: `${workspace.slug}:${skill.slug}`,
            name: skill.name,
            slug: skill.slug,
            workspaceName: workspace.name,
            workspaceSlug: workspace.slug,
            updatedAt: skill.updatedAt,
          }))
        }),
      )
      setRows(groups.flat())
    } catch (error) {
      console.error('[设置] 加载 Skills 失败:', error)
    } finally {
      setLoaded(true)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  // Add 菜单：列出可导入的来源（每个工作区视角下的其他工作区 Skill）
  React.useEffect(() => {
    if (!addMenuOpen) return
    let cancelled = false
    ;(async () => {
      const workspaces = await window.electronAPI.listAgentWorkspaces().catch(() => [])
      const first = workspaces[0]
      if (!first) return
      const groups = await window.electronAPI.getOtherWorkspaceSkills(first.slug).catch(() => [])
      if (!cancelled) setImportSources(groups)
    })()
    return () => { cancelled = true }
  }, [addMenuOpen])

  // 点击外部关闭 Add 菜单
  React.useEffect(() => {
    if (!addMenuOpen) return
    const handleClickOutside = (event: MouseEvent): void => {
      if (addMenuRef.current && !addMenuRef.current.contains(event.target as Node)) {
        setAddMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [addMenuOpen])

  const filteredRows = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) =>
      row.name.toLowerCase().includes(q) || row.slug.toLowerCase().includes(q),
    )
  }, [rows, query])

  const handleImport = async (sourceSlug: string, skillSlug: string): Promise<void> => {
    setAddMenuOpen(false)
    try {
      const workspaces = await window.electronAPI.listAgentWorkspaces()
      const target = workspaces[0]
      if (!target) return
      await window.electronAPI.importSkillFromWorkspace(target.slug, sourceSlug, skillSlug)
      toast.success(t('skills.imported', { skill: skillSlug, workspace: target.name }))
      void load()
    } catch (error) {
      toast.error(t('skills.importFailed'), { description: error instanceof Error ? error.message : t('common.unknownError') })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-8 pb-6 pt-8" data-settings-page="skills">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[17px] font-semibold text-foreground">{t('skills.title')}</h1>
        <div className="flex items-center gap-2">
          <div className="flex h-[30px] w-[180px] items-center gap-1.5 rounded-lg border border-border/70 bg-background px-2.5 text-muted-foreground focus-within:border-foreground/25">
            <Search size={13} className="shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('common.search')}
              aria-label={t('skills.search')}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <div ref={addMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setAddMenuOpen((open) => !open)}
              className="flex h-[30px] items-center gap-1 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-foreground/[0.04]"
            >
              {t('skills.add')}
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
            {addMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 max-h-[240px] w-[260px] overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-md">
                {importSources.length === 0 && (
                  <div className="px-3 py-2 text-[12px] text-muted-foreground">{t('skills.noSources')}</div>
                )}
                {importSources.map((group) => (
                  <div key={group.workspaceSlug}>
                    <div className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                      {group.workspaceName}
                    </div>
                    {group.skills.map((skill) => (
                      <button
                        key={skill.slug}
                        type="button"
                        className="w-full px-3 py-1.5 text-left text-[13px] text-foreground/85 transition-colors hover:bg-accent/70"
                        onClick={() => void handleImport(group.workspaceSlug, skill.slug)}
                      >
                        {skill.name}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 表格：Skill / Last updated / Author（对齐参考列） */}
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border/60 text-left text-muted-foreground">
              <th className="pb-2 font-normal">{t('skills.title')}</th>
              <th className="pb-2 font-normal">{t('skills.lastUpdated')}</th>
              <th className="pb-2 font-normal">{t('skills.author')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.key} className="border-b border-border/40 last:border-0">
                <td className="py-2.5 pr-4 text-foreground">
                  {row.name}
                  <span className="ml-2 text-[11px] text-muted-foreground/60">{row.workspaceName}</span>
                </td>
                <td className="py-2.5 pr-4 tabular-nums text-foreground/70">{formatUpdatedAt(row.updatedAt)}</td>
                <td className="py-2.5 text-foreground/70">{t('common.you')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loaded && filteredRows.length === 0 && (
          <div className="py-12 text-center text-[13px] text-muted-foreground">
            {rows.length === 0 ? t('skills.empty') : t('skills.noMatches')}
          </div>
        )}
      </div>
    </div>
  )
}

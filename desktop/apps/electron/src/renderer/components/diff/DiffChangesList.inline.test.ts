import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip'
import { agentDiffDataAtom } from '@/atoms/agent-atoms'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'
import { DiffChangesList } from './DiffChangesList'

function renderChanges(language: 'zh' | 'en', sessionId = 'a'): string {
  const store = createStore()
  store.set(settingsPreferencesAtom, (value) => ({ ...value, interfaceLanguage: language }))
  store.set(agentDiffDataAtom, new Map([['a:session', {
    isGitRepo: true,
    gitRootNames: ['repo'],
    files: [{ filePath: 'src/main.ts', status: 'modified' as const, additions: 2, deletions: 1, source: 'session' as const, gitRoot: '/repo' }],
    untrackedFiles: [{ filePath: 'new.ts', gitRoot: '/repo' }],
  }]]))
  return renderToStaticMarkup(createElement(Provider, { store },
    createElement(TooltipProvider, { children: createElement(DiffChangesList, { dirPath: '/repo', sessionId }) }),
  ))
}

describe('文件改动内联展开', () => {
  test('Given 已追踪和未追踪的改动 When 初次打开 Then 各文件默认收起且可独立展开', () => {
    const html = renderChanges('zh')
    expect(html).toContain('main.ts')
    expect(html).toContain('new.ts')
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2)
    expect(html).not.toContain('data-inline-file-diff')
  })

  test('Given 文件改动面板 When 切换语言 Then 文件分组和操作提示随设置切换', () => {
    expect(renderChanges('zh')).toContain('未追踪文件')
    const english = renderChanges('en')
    expect(english).toContain('Untracked files')
    expect(english).not.toContain('未追踪文件')
  })

  test('Given A 的改动已缓存 When 查看 B Then 不显示 A 的文件列表', () => {
    const html = renderChanges('zh', 'b')
    expect(html).not.toContain('main.ts')
    expect(html).not.toContain('new.ts')
    expect(html).toContain('加载中')
  })
})

import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { useOpenPreview } from '../diff/preview-opener'
import { previewFileMapAtom, previewPanelOpenMapAtom } from '@/atoms/preview-atoms'
import { currentAgentSessionIdAtom, agentDiffPanelTabAtom, agentSidePanelOpenAtom } from '@/atoms/agent-atoms'

function mountPreviewOpener(store: ReturnType<typeof createStore>): ReturnType<typeof useOpenPreview> {
  let open: ReturnType<typeof useOpenPreview> | undefined
  function Probe() {
    open = useOpenPreview()
    return null
  }
  renderToStaticMarkup(createElement(Provider, { store }, createElement(Probe)))
  if (!open) throw new Error('预览入口未挂载')
  return open
}

describe('浮动右侧 Files 面板路由', () => {
  test('Given 消息文件入口 When 打开文件 Then 保存路径上下文并打开右侧 Files，不打开中央分屏', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'a')
    const file = { filePath: 'src/index.ts', gitRoot: '/repo', dirPath: '/repo/worktree' }
    mountPreviewOpener(store)('a', file)
    expect(store.get(previewFileMapAtom).get('a')).toEqual(file)
    expect(store.get(agentSidePanelOpenAtom)).toBe(true)
    expect(store.get(agentDiffPanelTabAtom).get('a')).toBe('files')
    expect(store.get(previewPanelOpenMapAtom).get('a')).not.toBe(true)
  })

  test('Given A 已选择文件 When 切换 B 并选择另一文件 Then 文件内容按会话隔离且切换时面板收起', () => {
    const store = createStore()
    const open = mountPreviewOpener(store)
    store.set(currentAgentSessionIdAtom, 'a')
    open('a', { filePath: '/repo/a.ts' })
    store.set(currentAgentSessionIdAtom, 'b')
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
    open('b', { filePath: '/repo/b.ts' })
    expect(store.get(previewFileMapAtom).get('a')?.filePath).toBe('/repo/a.ts')
    expect(store.get(previewFileMapAtom).get('b')?.filePath).toBe('/repo/b.ts')
    store.set(currentAgentSessionIdAtom, 'a')
    expect(store.get(agentSidePanelOpenAtom)).toBe(false)
  })
})

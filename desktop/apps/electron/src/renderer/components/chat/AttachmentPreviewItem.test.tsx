import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { settingsPreferencesAtom } from '@/atoms/settings-preferences'
import { AttachmentPreviewItem } from './AttachmentPreviewItem'

function renderAttachment(language: 'zh' | 'en', mediaType: string): string {
  const store = createStore()
  store.set(settingsPreferencesAtom, current => ({ ...current, interfaceLanguage: language }))
  return renderToStaticMarkup(
    <Provider store={store}>
      <AttachmentPreviewItem
        filename="README.md"
        mediaType={mediaType}
        previewUrl={mediaType.startsWith('image/') ? 'data:image/png;base64,AAAA' : undefined}
        onRemove={() => {}}
      />
    </Provider>,
  )
}

describe('附件预览移除操作', () => {
  test('Given 英文界面 When 渲染文档附件 Then 移除按钮包含文件名和英文动作名称', () => {
    expect(renderAttachment('en', 'text/markdown'))
      .toContain('aria-label="Remove attachment README.md"')
  })

  test('Given 中文界面 When 渲染图片附件 Then 移除按钮包含文件名和中文动作名称', () => {
    expect(renderAttachment('zh', 'image/png'))
      .toContain('aria-label="移除附件 README.md"')
  })
})

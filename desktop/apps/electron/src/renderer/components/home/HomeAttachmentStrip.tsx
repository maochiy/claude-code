import * as React from 'react'
import { AttachmentPreviewItem } from '@/components/chat/AttachmentPreviewItem'

export interface HomePendingAttachment {
  id: string
  filename: string
  mediaType: string
  size: number
  data: string
  previewUrl?: string
}

interface HomeAttachmentStripProps {
  attachments: HomePendingAttachment[]
  onRemove: (id: string) => void
}

/** 首页首轮附件预览；数据仅保留到目标会话创建并绑定成功。 */
export function HomeAttachmentStrip({
  attachments,
  onRemove,
}: HomeAttachmentStripProps): React.ReactElement | null {
  const imageAttachments = React.useMemo(
    () => attachments.filter(item => item.mediaType.startsWith('image/') && item.previewUrl),
    [attachments],
  )
  const imageSiblings = React.useMemo(
    () => imageAttachments.map(item => ({
      previewUrl: item.previewUrl as string,
      filename: item.filename,
    })),
    [imageAttachments],
  )

  if (attachments.length === 0) return null
  return (
    <div className="mb-2 flex flex-wrap gap-2" data-home-attachments>
      {attachments.map(item => (
        <AttachmentPreviewItem
          key={item.id}
          filename={item.filename}
          mediaType={item.mediaType}
          previewUrl={item.previewUrl}
          onRemove={() => onRemove(item.id)}
          imageSiblings={imageSiblings}
          siblingIndex={imageAttachments.findIndex(image => image.id === item.id)}
        />
      ))}
    </div>
  )
}

import sharp from 'sharp'
import { maybeResizeAndDownsampleImageBuffer } from '../utils/imageResizer.js'

/**
 * 构建期冒烟测试：确保桌面 Runtime 内的 Sharp 原生模块可加载，
 * 并能把超过查看上限的图片真实缩放到 2000px 以内。
 */
export async function verifyDesktopImageRuntime(): Promise<void> {
  const source = await sharp({
    create: {
      width: 2560,
      height: 1330,
      channels: 3,
      background: { r: 36, g: 42, b: 54 },
    },
  })
    .png()
    .toBuffer()

  const resized = await maybeResizeAndDownsampleImageBuffer(
    source,
    source.length,
    'png',
  )
  const metadata = await sharp(resized.buffer).metadata()

  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width > 2000 ||
    metadata.height > 2000
  ) {
    throw new Error(
      `桌面 Runtime 图片缩放冒烟验证失败: ${metadata.width ?? 'unknown'}x${metadata.height ?? 'unknown'}`,
    )
  }
}

/**
 * PlaceholderPage - 设置模态框占位页
 *
 * Privacy / Usage 在图 8 中仅有一级页面入口，功能暂未展开，
 * 提供与 General 页一致排版的空状态。
 */

interface PlaceholderPageProps {
  title: string
  description: string
}

export function PlaceholderPage({ title, description }: PlaceholderPageProps): React.ReactElement {
  return (
    <div className="mx-auto w-full max-w-[712px] pb-10 pt-8" data-settings-page="placeholder">
      <h1 className="text-[17px] font-semibold text-foreground">{title}</h1>
      <p className="mt-3 text-[13px] leading-5 text-muted-foreground">{description}</p>
    </div>
  )
}

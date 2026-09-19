/**
 * 先让 Runtime 应用会话级自动压缩设置，再持久化宿主偏好。
 * Runtime 拒绝或失败时不得把未生效的值写入会话元数据。
 */
export async function applyAndPersistSessionAutoCompact<TResult>(
  applyRuntimeSetting: () => Promise<TResult>,
  persistPreference: () => void,
): Promise<TResult> {
  const result = await applyRuntimeSetting()
  persistPreference()
  return result
}

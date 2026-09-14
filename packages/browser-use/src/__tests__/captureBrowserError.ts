import { BrowserError } from '../protocol.js'

/** 捕获同步抛出的 BrowserError（未抛出或类型不符时让测试失败）。 */
export function captureSync(fn: () => unknown): BrowserError {
  try {
    fn()
  } catch (error) {
    if (error instanceof BrowserError) return error
    throw error
  }
  throw new Error('expected fn to throw BrowserError')
}

/** 捕获 Promise 拒绝携带的 BrowserError。 */
export async function captureAsync(
  promise: Promise<unknown>,
): Promise<BrowserError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof BrowserError) return error
    throw error
  }
  throw new Error('expected promise to reject with BrowserError')
}

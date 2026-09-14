/**
 * 后台页面控制层：所有 page.* 操作都优先走 chrome.debugger（CDP）。
 *
 * 目标：标签页可以在**后台**被驱动 —— 不激活标签、不切换窗口焦点、截图不要求
 * 标签是当前可见的活动标签。scripting API 只作为 debugger 不可用（例如用户已经
 * 对该标签打开 DevTools）时的降级路径。
 *
 * 注入到页面里的函数必须是自包含的（不能引用模块作用域变量），因为它们会以源码
 * 字符串形式通过 Runtime.evaluate 执行，也会原样交给 chrome.scripting.executeScript。
 */

const DEBUGGER_VERSION = '1.3'
const MAX_INPUT = 10000

/** 按键名 → CDP Input.dispatchKeyEvent 参数。 */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: {
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
  },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
}
for (let index = 1; index <= 12; index += 1) {
  KEYS['F' + index] = {
    key: 'F' + index,
    code: 'F' + index,
    windowsVirtualKeyCode: 111 + index,
  }
}

const attached = new Set()
const failures = new Map()

function pageError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

chrome.debugger.onDetach.addListener(source => {
  if (source && source.tabId != null) attached.delete(source.tabId)
})

/** 该标签是否已挂上 debugger。 */
export const isAttached = tabId => attached.has(tabId)
export const attachedTabs = () => [...attached]
/** debugger 最近一次 attach 失败原因（没有失败则为 undefined）。 */
export const attachFailure = tabId => failures.get(tabId)

/** 标签关闭时清理本地状态。 */
export function forget(tabId) {
  attached.delete(tabId)
  failures.delete(tabId)
}

/** 确保 debugger 已挂上；返回是否可用（不抛错，供降级路径判断）。 */
export async function ensureAttached(tabId) {
  if (attached.has(tabId)) return true
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION)
  } catch (error) {
    const message = String((error && error.message) || error)
    if (!/already attached/i.test(message)) {
      failures.set(tabId, message)
      return false
    }
  }
  attached.add(tabId)
  failures.delete(tabId)
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {})
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable').catch(() => {})
  return true
}

/**
 * CDP Input.* 事件只对前台活动标签生效（devtools-protocol#89：非活动标签上
 * 事件不投递，mouseWheel 的 ack 甚至永不返回，把请求挂死到超时）。本产品的
 * 核心场景恰恰是后台标签（active:false），所以真实输入只在标签可见时走 CDP，
 * 否则一律走页面内脚本路径 —— Runtime.evaluate 在后台标签上完全可用。
 */
async function isTabActive(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  return !!tab && tab.active === true
}

/** 主动摘掉 debugger（会移除 Chrome 的“正在调试”提示条）。 */
export async function detach(tabId) {
  if (!attached.has(tabId)) return false
  attached.delete(tabId)
  await chrome.debugger.detach({ tabId }).catch(() => {})
  return true
}

/** 发送一条 CDP 命令，必要时先挂 debugger。 */
export async function command(tabId, method, params = {}) {
  if (!attached.has(tabId) && !(await ensureAttached(tabId))) {
    throw pageError(
      'DEBUGGER_UNAVAILABLE',
      '无法在后台控制该标签（debugger attach 失败）：' +
        (failures.get(tabId) || 'unknown'),
    )
  }
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params)
  } catch (error) {
    throw pageError(
      'DEBUGGER_COMMAND_FAILED',
      method + ' 失败：' + String((error && error.message) || error),
    )
  }
}

/** 在页面中执行自包含函数；debugger 可用走 CDP，否则降级到 scripting。 */
export async function run(tabId, fn, args = []) {
  if (await ensureAttached(tabId)) {
    const expression =
      '(' +
      Function.prototype.toString.call(fn) +
      ').apply(null, ' +
      JSON.stringify(args) +
      ')'
    const response = await command(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    const details = response && response.exceptionDetails
    if (details) {
      const text =
        (details.exception &&
          (details.exception.description || details.exception.value)) ||
        details.text ||
        '页面脚本执行失败'
      throw pageError('PAGE_EVALUATION_FAILED', String(text).split('\n')[0])
    }
    return response && response.result ? response.result.value : undefined
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args,
  })
  return results && results[0] ? results[0].result : undefined
}

/* ------------------------------------------------------------------ 页面函数 */

/**
 * 读取页面 URL、标题、正文与可交互元素。
 *
 * 快照同时把这些元素登记进页面内的引用表 `globalThis.__ccbRefs`（ref -> element），
 * 之后的点击/输入直接按 ref 取元素，不依赖下标，也不会因为两次查询用的选择器不同而错位。
 */
export function snapshotFn(snapshotId) {
  const SELECTOR =
    'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]'
  const refs = new Map()
  globalThis.__ccbRefs = refs
  const elements = [...document.querySelectorAll(SELECTOR)].slice(0, 200)
  return {
    url: location.href,
    title: document.title,
    text: ((document.body && document.body.innerText) || '').slice(0, 20000),
    elements: elements.map((element, index) => {
      const ref = snapshotId + ':' + index
      refs.set(ref, element)
      const type = element.getAttribute('type') || ''
      const sensitive =
        type.toLowerCase() === 'password' ||
        /password|credit|card|cvv|cvc|验证码/i.test(
          (element.getAttribute('name') || '') +
            ' ' +
            (element.getAttribute('autocomplete') || ''),
        )
      const rect = element.getBoundingClientRect()
      return {
        ref,
        index,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        type,
        name:
          element.getAttribute('aria-label') || element.getAttribute('name'),
        id: element.id || null,
        placeholder: element.getAttribute('placeholder'),
        text: sensitive
          ? ''
          : (
              element.innerText ||
              element.getAttribute('aria-label') ||
              ''
            ).slice(0, 500),
        value: sensitive
          ? ''
          : element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement
            ? element.value.slice(0, 500)
            : '',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        disabled: !!element.disabled,
      }
    }),
  }
}

/**
 * 单个元素上的动作：point / click / focus / read / set。
 * 只用于脚本路径与坐标测量；真实点击与输入仅在标签前台可见时走 CDP Input.*
 * （后台标签收不到 CDP 输入事件，一律走本函数的脚本路径）。
 */
export function elementFn(ref, action, payload) {
  const SELECTOR =
    'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]'
  const registry = globalThis.__ccbRefs
  let element =
    registry && typeof registry.get === 'function' ? registry.get(ref) : null
  if (!element || !element.isConnected) {
    element =
      [...document.querySelectorAll(SELECTOR)][
        Number(String(ref).split(':')[1])
      ] || null
  }
  if (!element) return { ok: false, reason: 'missing' }
  if (action === 'point') {
    try {
      element.scrollIntoView({
        block: 'center',
        inline: 'center',
        behavior: 'instant',
      })
    } catch {
      element.scrollIntoView()
    }
    const rect = element.getBoundingClientRect()
    return {
      ok: true,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      width: rect.width,
      height: rect.height,
    }
  }
  if (action === 'click') {
    try {
      element.scrollIntoView({ block: 'center', behavior: 'instant' })
    } catch {
      element.scrollIntoView()
    }
    element.click()
    return { ok: true }
  }
  if (action === 'focus') {
    try {
      element.scrollIntoView({ block: 'center', behavior: 'instant' })
    } catch {
      element.scrollIntoView()
    }
    element.focus()
    if (element.isContentEditable) {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    } else if (typeof element.select === 'function') {
      element.select()
    }
    return { ok: true }
  }
  if (action === 'read') {
    if (element.isContentEditable)
      return { ok: true, value: element.textContent || '' }
    return { ok: true, value: element.value || '' }
  }
  if (action === 'set') {
    element.focus()
    if (element.isContentEditable) {
      element.textContent = payload
    } else {
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
      if (descriptor && descriptor.set) descriptor.set.call(element, payload)
      else element.value = payload
    }
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: payload,
      }),
    )
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true }
  }
  return { ok: false, reason: 'unsupported-action' }
}

/** 视口尺寸，用于把点击坐标夹到可见区域内。 */
export function viewportFn() {
  return { width: window.innerWidth, height: window.innerHeight }
}

/** 纯脚本按键（后台标签路径）。非信任事件不触发浏览器默认行为
    （比如 Enter 提交表单），这里对最常见的 Enter 语义显式补上 requestSubmit。 */
export function keyFn(key) {
  const target = document.activeElement || document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
  if (key === 'Enter' && target instanceof Element && 'form' in target) {
    try {
      target.form?.requestSubmit()
    } catch {}
  }
  return true
}

/** 页面内历史导航：chrome.tabs.goBack/goForward 在后台标签上会拒绝执行
    （"Cannot find a next/previous page in history"，且导航不发生），而页面侧
    history.go() 与脚本导航一样在后台完全可用。 */
export function historyGoFn(delta) {
  history.go(delta)
  return true
}

/** 页面内重载（tabs.reload 的降级路径）。 */
export function reloadFn() {
  location.reload()
  return true
}

/** 纯脚本滚动（降级路径）。 */
export function scrollFn(x, y) {
  window.scrollBy(x, y)
  return { x: window.scrollX, y: window.scrollY }
}

/* ------------------------------------------------------------------ 对外操作 */

export function snapshot(tabId, snapshotId) {
  return run(tabId, snapshotFn, [snapshotId])
}

export async function clickElement(tabId, ref) {
  if ((await isTabActive(tabId)) && (await ensureAttached(tabId))) {
    const point = await run(tabId, elementFn, [ref, 'point'])
    if (!point || !point.ok)
      throw pageError(
        'ELEMENT_NOT_FOUND',
        '元素不存在或已刷新，请重新调用 browser_get_state',
      )
    if (point.width > 0 && point.height > 0) {
      const viewport = (await run(tabId, viewportFn)) || {
        width: 1024,
        height: 768,
      }
      const x = Math.min(Math.max(point.x, 1), Math.max(viewport.width - 1, 1))
      const y = Math.min(Math.max(point.y, 1), Math.max(viewport.height - 1, 1))
      await command(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
        buttons: 0,
      })
      await command(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      })
      await command(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
      return { mode: 'cdp', x, y }
    }
  }
  const clicked = await run(tabId, elementFn, [ref, 'click'])
  if (!clicked || !clicked.ok)
    throw pageError(
      'ELEMENT_NOT_FOUND',
      '元素不存在或已刷新，请重新调用 browser_get_state',
    )
  return { mode: 'script' }
}

export async function typeText(tabId, ref, text) {
  if (typeof text !== 'string' || text.length > MAX_INPUT)
    throw pageError('INVALID_PARAMS', '输入内容过长或类型不正确')
  const focused = await run(tabId, elementFn, [ref, 'focus'])
  if (!focused || !focused.ok)
    throw pageError(
      'ELEMENT_NOT_FOUND',
      '输入元素不存在或已刷新，请重新调用 browser_get_state',
    )
  if ((await isTabActive(tabId)) && (await ensureAttached(tabId))) {
    await command(tabId, 'Input.insertText', { text })
    const read = await run(tabId, elementFn, [ref, 'read'])
    const value = read && read.ok ? read.value : null
    if (
      !read ||
      !read.ok ||
      (text.length > 0 && String(value ?? '').length === 0)
    ) {
      await run(tabId, elementFn, [ref, 'set', text])
      return { mode: 'script' }
    }
    return { mode: 'cdp' }
  }
  await run(tabId, elementFn, [ref, 'set', text])
  return { mode: 'script' }
}

export async function pressKey(tabId, key) {
  const definition = KEYS[key]
  if (!definition) throw pageError('INVALID_PARAMS', '不支持的按键：' + key)
  if ((await isTabActive(tabId)) && (await ensureAttached(tabId))) {
    const down = {
      type: 'keyDown',
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
    }
    if (definition.text != null) down.text = definition.text
    await command(tabId, 'Input.dispatchKeyEvent', down)
    await command(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
    })
    return { mode: 'cdp' }
  }
  await run(tabId, keyFn, [key])
  return { mode: 'script' }
}

export async function scrollBy(tabId, x, y) {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    Math.abs(x) > 5000 ||
    Math.abs(y) > 5000
  )
    throw pageError('INVALID_PARAMS', '滚动参数不合法')
  if ((await isTabActive(tabId)) && (await ensureAttached(tabId))) {
    const viewport = (await run(tabId, viewportFn)) || {
      width: 1024,
      height: 768,
    }
    await command(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(viewport.width / 2),
      y: Math.round(viewport.height / 2),
      deltaX: x,
      deltaY: y,
      pointerType: 'mouse',
    })
    return { mode: 'cdp' }
  }
  const position = await run(tabId, scrollFn, [x, y])
  return { mode: 'script', position }
}

/** 截图：CDP 可在后台标签上截图；debugger 不可用时退化为“标签必须是可见活动标签”。 */
export async function screenshot(tabId) {
  if (await ensureAttached(tabId)) {
    const shot = await command(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 85,
      fromSurface: true,
    })
    if (shot && shot.data)
      return { base64: shot.data, mediaType: 'image/jpeg', mode: 'cdp' }
    throw pageError('SCREENSHOT_FAILED', 'CDP 未返回截图数据')
  }
  const tab = await chrome.tabs.get(tabId)
  if (!tab.active)
    throw pageError(
      'DEBUGGER_UNAVAILABLE',
      '该标签无法在后台截图（debugger 不可用，且标签不是可见活动标签）',
    )
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'jpeg',
    quality: 85,
  })
  return {
    base64: shot.replace(/^data:image\/jpeg;base64,/, ''),
    mediaType: 'image/jpeg',
    mode: 'visible-tab',
  }
}

export { MAX_INPUT }

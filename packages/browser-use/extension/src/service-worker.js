/**
 * CCB Browser Use —— MV3 service worker。
 *
 * 两条主线：
 * 1) **会话分组**：每个 ccx 会话（sessionId）拥有自己的 Chrome 标签组，组名就是
 *    会话名称；该会话打开的标签一律进入这个分组。
 * 2) **后台控制**：所有操作都不激活标签、不切换窗口焦点，页面读写与截图走 CDP
 *    （见 ./cdp.js），用户可以在会话运行期间继续正常使用 Chrome。
 */
import {
  clickElement,
  detach as detachDebugger,
  ensureAttached,
  forget as forgetDebugger,
  historyGoFn,
  isAttached,
  pressKey,
  reloadFn,
  run,
  scrollBy,
  screenshot,
  snapshot,
  typeText,
} from './cdp.js'

const PROTOCOL = 'ccb-browser/1'
const FEATURES = ['session-groups', 'background-cdp', 'no-focus-steal']
const DEFAULT_SESSION = 'default'
const DEFAULT_TITLE = 'CCX 会话'
const GROUP_COLOR = 'blue'
const STORAGE_KEY = 'ccb-sessions'
const MAX_TITLE = 48

/** 会话状态：sessionId -> { id, title, groupId, groupTitle, windowId, tabs, createdAt, updatedAt } */
const sessions = new Map()
/** 已授权标签：tabId -> { sessionId, ownership, taskId, navigation, protocol } */
const controlled = new Map()
/** 快照：tabId -> { id, navigation } */
const snapshots = new Map()

let nativePort = null
let reconnectTimer = null
let restored = null
let persistTimer = null

const ok = result => ({ ok: true, result })
const fail = (code, message, retryable = false) => ({
  ok: false,
  error: { code, message, retryable },
})
const envelope = (id, result) => ({
  protocol: PROTOCOL,
  type: 'response',
  id,
  ...result,
})
const validId = value => Number.isInteger(value) && value > 0
const urlOf = tab => (typeof tab?.url === 'string' ? tab.url : '')

function browserError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function failOf(error) {
  return fail(
    error?.code || 'FAILED',
    error?.message || '浏览器操作失败',
    !!error?.retryable,
  )
}

function protocolOf(url) {
  try {
    return new URL(url).protocol
  } catch {
    return 'about:'
  }
}

function pageSupported(protocol) {
  return protocol === 'http:' || protocol === 'https:' || protocol === 'about:'
}

function normalizeTitle(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > MAX_TITLE ? text.slice(0, MAX_TITLE) : text
}

/* ------------------------------------------------------------------ 持久化 */

function serialize() {
  return [...sessions.values()].map(session => ({
    sessionId: session.id,
    title: session.title,
    groupId: session.groupId,
    groupTitle: session.groupTitle,
    windowId: session.windowId,
    tabs: [...session.tabs.entries()].map(([tabId, info]) => ({
      tabId,
      ...info,
    })),
  }))
}

function persist() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    chrome.storage.session.set({ [STORAGE_KEY]: serialize() }).catch(() => {})
  }, 120)
}

async function restore() {
  if (!restored)
    restored = (async () => {
      const stored = await chrome.storage.session
        .get(STORAGE_KEY)
        .catch(() => ({}))
      const list = Array.isArray(stored?.[STORAGE_KEY])
        ? stored[STORAGE_KEY]
        : []
      for (const entry of list) {
        if (!entry || typeof entry.sessionId !== 'string') continue
        const tabs = new Map()
        for (const tab of Array.isArray(entry.tabs) ? entry.tabs : []) {
          if (!validId(tab?.tabId)) continue
          const live = await chrome.tabs.get(tab.tabId).catch(() => null)
          if (!live) continue
          const ownership =
            tab.ownership === 'host-created' ? 'host-created' : 'user-owned'
          tabs.set(tab.tabId, { taskId: tab.taskId ?? null, ownership })
          controlled.set(tab.tabId, {
            sessionId: entry.sessionId,
            ownership,
            taskId: tab.taskId ?? null,
            navigation: 0,
            protocol: protocolOf(urlOf(live)),
          })
        }
        let groupId = validId(entry.groupId) ? entry.groupId : null
        if (groupId != null)
          await chrome.tabGroups.get(groupId).catch(() => {
            groupId = null
          })
        sessions.set(entry.sessionId, {
          id: entry.sessionId,
          title: normalizeTitle(entry.title) || DEFAULT_TITLE,
          groupId,
          groupTitle:
            typeof entry.groupTitle === 'string' ? entry.groupTitle : '',
          windowId: validId(entry.windowId) ? entry.windowId : null,
          tabs,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      }
    })().catch(() => {})
  return restored
}

/* ------------------------------------------------------------------ 会话分组 */

function sessionOf(env) {
  const id =
    typeof env?.sessionId === 'string' && env.sessionId
      ? env.sessionId
      : DEFAULT_SESSION
  const incoming = normalizeTitle(env?.sessionTitle)
  let session = sessions.get(id)
  if (!session) {
    session = {
      id,
      title: incoming || DEFAULT_TITLE,
      groupId: null,
      groupTitle: '',
      windowId: null,
      tabs: new Map(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    sessions.set(id, session)
    persist()
    return session
  }
  if (incoming && incoming !== session.title) {
    session.title = incoming
    session.updatedAt = Date.now()
    void syncGroupTitle(session)
    persist()
  }
  return session
}

async function syncGroupTitle(session) {
  if (session.groupId == null || session.groupTitle === session.title) return
  try {
    await chrome.tabGroups.update(session.groupId, {
      title: session.title,
      color: GROUP_COLOR,
      collapsed: false,
    })
    session.groupTitle = session.title
    persist()
  } catch {
    session.groupId = null
    session.groupTitle = ''
  }
}

async function resolveWindow(session) {
  if (session.windowId != null) {
    const known = await chrome.windows.get(session.windowId).catch(() => null)
    if (known) return session.windowId
    session.windowId = null
  }
  const known = [...session.tabs.keys()][0]
  if (known != null) {
    const live = await chrome.tabs.get(known).catch(() => null)
    if (live) {
      session.windowId = live.windowId
      return live.windowId
    }
  }
  const last = await chrome.windows
    .getLastFocused({ windowTypes: ['normal'] })
    .catch(() => null)
  return last?.id ?? null
}

/** 把标签放进会话分组（必要时新建分组）；分组名始终等于会话名。 */
async function joinGroup(session, tabId) {
  const tab = await chrome.tabs.get(tabId)
  const windowId = tab.windowId
  if (session.groupId != null) {
    const group = await chrome.tabGroups.get(session.groupId).catch(() => null)
    if (group && group.windowId === windowId) {
      if (tab.groupId !== session.groupId)
        await chrome.tabs
          .group({ groupId: session.groupId, tabIds: [tabId] })
          .catch(() => {})
      session.windowId = windowId
      await syncGroupTitle(session)
      return session.groupId
    }
    session.groupId = null
    session.groupTitle = ''
  }
  const groupId = await chrome.tabs.group({
    tabIds: [tabId],
    createProperties: { windowId },
  })
  session.groupId = groupId
  session.groupTitle = ''
  session.windowId = windowId
  await chrome.tabGroups
    .update(groupId, {
      title: session.title,
      color: GROUP_COLOR,
      collapsed: false,
    })
    .catch(() => {})
  session.groupTitle = session.title
  persist()
  return groupId
}

/** 只有在“插件创建的标签”或“已经在该分组里的标签”上才动分组，避免搬动用户自己的标签。 */
async function maybeJoinGroup(session, tabId, ownership) {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab) return
  if (
    ownership === 'host-created' ||
    (session.groupId != null && tab.groupId === session.groupId)
  )
    await joinGroup(session, tabId)
}

/** 在会话分组里新建一个后台标签：active:false，不激活、不抢焦点。 */
async function createSessionTab(session, url, taskId) {
  const requested = typeof url === 'string' && url ? url : 'about:blank'
  if (requested !== 'about:blank' && !/^https?:\/\//i.test(requested))
    throw browserError('UNSUPPORTED_PAGE', '只支持 http/https 页面')
  const windowId = await resolveWindow(session)
  const tab = await chrome.tabs.create({
    url: requested,
    active: false,
    ...(windowId != null ? { windowId } : {}),
  })
  if (!tab?.id) throw browserError('TARGET_NOT_FOUND', '无法创建后台标签')
  await joinGroup(session, tab.id)
  bind(session, tab.id, {
    taskId,
    ownership: 'host-created',
    protocol: protocolOf(urlOf(tab) || requested),
  })
  return tab
}

function bind(
  session,
  tabId,
  { taskId = null, ownership = 'user-owned', protocol = 'about:' } = {},
) {
  session.tabs.set(tabId, { taskId, ownership })
  controlled.set(tabId, {
    sessionId: session.id,
    ownership,
    taskId,
    navigation: 0,
    protocol,
  })
  persist()
  return controlled.get(tabId)
}

function unbind(tabId) {
  const state = controlled.get(tabId)
  controlled.delete(tabId)
  snapshots.delete(tabId)
  if (state) sessions.get(state.sessionId)?.tabs.delete(tabId)
  return state
}

function stateOf(env, tabId) {
  if (!validId(tabId)) throw browserError('INVALID_PARAMS', '缺少 tabId')
  const session = sessionOf(env)
  const state = controlled.get(tabId)
  if (!state || state.sessionId !== session.id)
    throw browserError('TARGET_NOT_AUTHORIZED', '该标签未授权给当前会话')
  return { session, state }
}

function invalidate(tabId) {
  snapshots.delete(tabId)
  const state = controlled.get(tabId)
  if (state) state.navigation += 1
}

async function waitForPage(tabId) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab) throw browserError('TARGET_NOT_FOUND', '标签已关闭')
    const url = urlOf(tab)
    if (
      (/^https?:\/\//i.test(url) || url === 'about:blank') &&
      tab.status === 'complete'
    )
      return tab
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return chrome.tabs.get(tabId)
}

/** 后台标签的历史导航：chrome.tabs.goBack/goForward 在后台标签上会拒绝执行
    （"Cannot find a next/previous page in history"，导航也不发生），所以走页面侧
    history.go(delta)，并以 URL 变化为成功判据轮询确认。 */
async function historyMove(tabId, delta) {
  const before = await chrome.tabs
    .get(tabId)
    .then(urlOf)
    .catch(() => null)
  await run(tabId, historyGoFn, [delta])
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const url = await chrome.tabs
      .get(tabId)
      .then(urlOf)
      .catch(() => null)
    if (url == null) throw browserError('TARGET_NOT_FOUND', '标签已关闭')
    if (before == null || url !== before) return
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

/** 后台重载：tabs.reload 优先，失败降级页面内 location.reload()。 */
async function reloadTab(tabId) {
  try {
    await chrome.tabs.reload(tabId)
  } catch {
    await run(tabId, reloadFn, [])
  }
}

/* ------------------------------------------------------------------ page.* */

const allowed = new Set([
  'ping',
  'sessions.list',
  'sessions.close',
  'tabs.list',
  'tabs.attach',
  'tabs.create',
  'tabs.navigate',
  'tabs.back',
  'tabs.forward',
  'tabs.reload',
  'tabs.detach',
  'tabs.closeCreated',
  'page.getState',
  'page.click',
  'page.type',
  'page.press',
  'page.scroll',
  'page.screenshot',
  'task.stop',
])

async function page(env, tabId, method, args = {}) {
  const { state } = stateOf(env, tabId)
  if (!pageSupported(state.protocol))
    throw browserError('UNSUPPORTED_PAGE', '只支持 http/https 页面')
  if (method === 'page.getState') {
    const snapshotId = crypto.randomUUID()
    const result = (await snapshot(tabId, snapshotId)) || {
      url: '',
      title: '',
      text: '',
      elements: [],
    }
    snapshots.set(tabId, { id: snapshotId, navigation: state.navigation })
    state.protocol = protocolOf(result.url || 'about:blank')
    return { ...result, snapshotId, elements: result.elements || [] }
  }
  if (method === 'page.screenshot') {
    const shot = await screenshot(tabId)
    return { base64: shot.base64, mediaType: shot.mediaType, mode: shot.mode }
  }
  if (method === 'page.press') return { ok: await pressKey(tabId, args.key) }
  if (method === 'page.scroll')
    return { ok: await scrollBy(tabId, args.x || 0, args.y || 0) }
  const parts = typeof args.ref === 'string' ? args.ref.split(':') : []
  const current = snapshots.get(tabId)
  if (
    !current ||
    current.navigation !== state.navigation ||
    parts[0] !== current.id ||
    !/^\d+$/.test(parts[1] || '')
  ) {
    throw browserError('STALE_REF', '元素引用已失效，请重新调用 page.getState')
  }
  if (method === 'page.click')
    return { ok: await clickElement(tabId, args.ref) }
  if (method === 'page.type')
    return { ok: await typeText(tabId, args.ref, args.text) }
  throw browserError('BAD_METHOD', '不支持的页面操作：' + method)
}

/* ------------------------------------------------------------------ 分发 */

async function dispatch(env, method, args = {}) {
  if (!allowed.has(method)) return fail('BAD_METHOD', '不允许的操作：' + method)
  await restore()
  try {
    if (method === 'ping') {
      return ok({
        protocol: PROTOCOL,
        features: FEATURES,
        extensionVersion: chrome.runtime.getManifest().version,
        sessions: [...sessions.values()].map(session => session.title),
      })
    }
    if (method === 'sessions.list') {
      const list = []
      for (const session of sessions.values()) {
        const tabs = []
        for (const [tabId, info] of [...session.tabs]) {
          const tab = await chrome.tabs.get(tabId).catch(() => null)
          if (!tab) {
            unbind(tabId)
            continue
          }
          tabs.push({
            tabId,
            title: tab.title || '',
            url: urlOf(tab),
            active: !!tab.active,
            ownership: info.ownership,
            taskId: info.taskId ?? null,
            debugged: isAttached(tabId),
          })
        }
        list.push({
          sessionId: session.id,
          title: session.title,
          groupId: session.groupId,
          windowId: session.windowId,
          tabs,
          updatedAt: session.updatedAt,
        })
      }
      return ok(list)
    }
    if (method === 'sessions.close') {
      const id =
        typeof args.sessionId === 'string' && args.sessionId
          ? args.sessionId
          : sessionOf(env).id
      const session = sessions.get(id)
      if (!session) return ok({ sessionId: id, closed: 0, detached: 0 })
      let closed = 0,
        detached = 0
      for (const [tabId, info] of [...session.tabs]) {
        if (info.ownership === 'host-created') {
          await chrome.tabs.remove(tabId).catch(() => {})
          closed += 1
        } else if (await detachDebugger(tabId)) detached += 1
        unbind(tabId)
        forgetDebugger(tabId)
      }
      sessions.delete(id)
      persist()
      return ok({ sessionId: id, closed, detached })
    }
    if (method === 'tabs.list') {
      const tabs = await chrome.tabs.query({})
      return ok(
        tabs
          .filter(tab => validId(tab.id))
          .map(tab => ({
            id: tab.id,
            url: urlOf(tab),
            title: tab.title || '',
            active: !!tab.active,
            windowId: tab.windowId,
            controlled: controlled.has(tab.id),
            sessionId: controlled.get(tab.id)?.sessionId ?? null,
            ownership: controlled.get(tab.id)?.ownership ?? null,
          })),
      )
    }
    if (method === 'tabs.attach') {
      const session = sessionOf(env)
      if (args.tabId == null) {
        for (const [tabId, info] of session.tabs) {
          const tab = await chrome.tabs.get(tabId).catch(() => null)
          if (!tab || !pageSupported(protocolOf(urlOf(tab)))) continue
          session.tabs.set(tabId, {
            taskId: env?.taskId ?? info.taskId ?? null,
            ownership: info.ownership,
          })
          await maybeJoinGroup(session, tabId, info.ownership)
          await ensureAttached(tabId)
          return ok({
            tab: {
              tabId,
              windowId: tab.windowId,
              url: urlOf(tab),
              title: tab.title || '',
            },
            ownership: info.ownership,
            reused: true,
          })
        }
        const created = await createSessionTab(
          session,
          'about:blank',
          env?.taskId ?? null,
        )
        await ensureAttached(created.id)
        return ok({
          tab: {
            tabId: created.id,
            windowId: created.windowId,
            url: 'about:blank',
            title: '',
          },
          ownership: 'host-created',
          reused: false,
        })
      }
      const tab = await chrome.tabs.get(args.tabId).catch(() => null)
      if (!tab?.id) throw browserError('TARGET_NOT_FOUND', '目标标签不存在')
      if (!pageSupported(protocolOf(urlOf(tab))))
        throw browserError('UNSUPPORTED_PAGE', '只支持 http/https 页面')
      // 归属由“谁创建了这个标签”决定，重复 attach 不会把插件创建的标签变成用户标签。
      const ownership = session.tabs.get(tab.id)?.ownership || 'user-owned'
      bind(session, tab.id, {
        taskId: env?.taskId ?? null,
        ownership,
        protocol: protocolOf(urlOf(tab)),
      })
      await ensureAttached(tab.id)
      return ok({
        tab: {
          tabId: tab.id,
          windowId: tab.windowId,
          url: urlOf(tab),
          title: tab.title || '',
        },
        ownership,
        reused: true,
      })
    }
    if (method === 'tabs.create') {
      const session = sessionOf(env)
      const tab = await createSessionTab(session, args.url, env?.taskId ?? null)
      const ready =
        urlOf(tab) === 'about:blank' ? tab : await waitForPage(tab.id)
      controlled.get(tab.id).protocol = protocolOf(
        urlOf(ready) || 'about:blank',
      )
      return ok({
        tab: {
          tabId: tab.id,
          windowId: tab.windowId,
          url: urlOf(ready) || urlOf(tab),
          title: ready.title || '',
        },
        ownership: 'host-created',
      })
    }
    if (method === 'tabs.navigate') {
      const { session, state } = stateOf(env, args.tabId)
      if (!/^https?:\/\//i.test(args.url || ''))
        throw browserError('UNSUPPORTED_PAGE', '只支持 http/https 页面')
      invalidate(args.tabId)
      state.protocol = protocolOf(args.url)
      await chrome.tabs.update(args.tabId, { url: args.url })
      const ready = await waitForPage(args.tabId)
      state.protocol = protocolOf(urlOf(ready) || args.url)
      await maybeJoinGroup(
        session,
        args.tabId,
        session.tabs.get(args.tabId)?.ownership,
      )
      return ok({
        tabId: args.tabId,
        url: urlOf(ready) || args.url,
        title: ready.title || '',
      })
    }
    if (method === 'tabs.back' || method === 'tabs.forward') {
      stateOf(env, args.tabId)
      await historyMove(args.tabId, method === 'tabs.back' ? -1 : 1)
      invalidate(args.tabId)
      return ok(true)
    }
    if (method === 'tabs.reload') {
      stateOf(env, args.tabId)
      await reloadTab(args.tabId)
      invalidate(args.tabId)
      return ok(true)
    }
    if (method === 'tabs.detach') {
      const { session } = stateOf(env, args.tabId)
      const info = session.tabs.get(args.tabId)
      unbind(args.tabId)
      await detachDebugger(args.tabId)
      persist()
      return ok({
        tabId: args.tabId,
        action: 'detached',
        ownership: info?.ownership || 'user-owned',
      })
    }
    if (method === 'tabs.closeCreated') {
      const { session } = stateOf(env, args.tabId)
      if (session.tabs.get(args.tabId)?.ownership !== 'host-created')
        return fail('NOT_CREATED', '只有插件创建的标签可以关闭')
      await chrome.tabs.remove(args.tabId).catch(() => {})
      unbind(args.tabId)
      forgetDebugger(args.tabId)
      persist()
      return ok({ tabId: args.tabId, action: 'closed' })
    }
    if (method === 'task.stop') {
      const session =
        (typeof args.sessionId === 'string' && sessions.get(args.sessionId)) ||
        sessionOf(env)
      let detached = 0
      for (const tabId of [...session.tabs.keys()])
        if (await detachDebugger(tabId)) detached += 1
      return ok({ sessionId: session.id, detached, action: 'stopped' })
    }
    if (method.startsWith('page.'))
      return ok(await page(env, args.tabId, method, args))
    return fail('BAD_METHOD', '未实现的操作：' + method)
  } catch (error) {
    return failOf(error)
  }
}

/* ------------------------------------------------------------------ 通道 */

async function onNative(message) {
  if (
    !message ||
    message.protocol !== PROTOCOL ||
    message.type !== 'request' ||
    typeof message.id !== 'string'
  )
    return
  const env = {
    taskId: message.taskId ?? null,
    sessionId: message.sessionId ?? null,
    sessionTitle: message.sessionTitle ?? null,
  }
  const result = await dispatch(env, message.method, message.params || {})
  try {
    nativePort?.postMessage(envelope(message.id, result))
  } catch {
    /* 端口已断开 */
  }
}

function connectNative() {
  if (nativePort) return
  const retry = () => {
    if (!nativePort && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connectNative()
      }, 2000)
    }
  }
  try {
    nativePort = chrome.runtime.connectNative('com.claudecodebest.browser')
    nativePort.onMessage.addListener(onNative)
    nativePort.onDisconnect.addListener(() => {
      // 必须消费 chrome.runtime.lastError，否则宿主缺失/名字非法导致的断开会被
      // Chrome 记成 "Unchecked runtime.lastError" 红字错误（重连循环每 2s 累积一条）。
      const reason = chrome.runtime.lastError?.message
      if (reason) console.warn('[ccb-browser] native host 断开：' + reason)
      nativePort = null
      clearTimeout(reconnectTimer)
      reconnectTimer = null
      retry()
    })
  } catch {
    // manifest 未安装等首连失败也要自愈（native host 由 CLI 首次调用工具时才装）
    nativePort = null
    retry()
  }
}

chrome.runtime.onMessage.addListener((message, _sender, send) => {
  if (message?.kind !== 'ccb') return
  const env = {
    taskId: message.taskId ?? null,
    sessionId: message.sessionId ?? null,
    sessionTitle: message.sessionTitle ?? null,
  }
  const reply = payload => {
    try {
      send(payload)
    } catch {
      /* 侧边栏已关闭 */
    }
  }
  dispatch(
    env,
    message.method || message.op,
    message.params || message.args || {},
  )
    .then(reply)
    .catch(error => reply(failOf(error)))
  return true
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!controlled.has(tabId)) return
  if (changeInfo.url || changeInfo.status === 'loading') {
    invalidate(tabId)
    if (changeInfo.url)
      controlled.get(tabId).protocol = protocolOf(changeInfo.url)
  }
})

chrome.tabs.onRemoved.addListener(tabId => {
  const state = unbind(tabId)
  forgetDebugger(tabId)
  if (state) persist()
})

chrome.tabGroups.onRemoved.addListener(group => {
  for (const session of sessions.values()) {
    if (session.groupId === group.groupId) {
      session.groupId = null
      session.groupTitle = ''
      persist()
    }
  }
})

// 兜底唤醒：重连等待期只有 setTimeout（弱保活），SW 可能在重连成功前被终止，
// 而宿主侧 stdio 无法唤醒死透的 SW。alarm 是能唤醒已终止 SW 的强信号 —— 醒来后
// 顶层 connectNative() 重建链路。端口健康时此 handler 是 no-op，不干扰强保活路径。
chrome.alarms.create('ccb-native-reconnect', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'ccb-native-reconnect' && !nativePort) connectNative()
})

connectNative()

const $ = id => document.getElementById(id)

async function send(method, params = {}) {
  const response = await chrome.runtime.sendMessage({
    kind: 'ccb',
    method,
    params,
  })
  if (!response?.ok) throw new Error(response?.error?.message || '请求失败')
  return response.result
}

const text = value => String(value ?? '')

function sessionNode(session) {
  const item = document.createElement('li')
  item.className = 'session'

  const head = document.createElement('div')
  head.className = 'session-head'
  const title = document.createElement('span')
  title.className = 'session-title'
  title.textContent = text(session.title)
  const badge = document.createElement('span')
  badge.className = 'badge'
  badge.textContent = session.tabs.length + ' 个标签'
  head.append(title, badge)

  const tabs = document.createElement('ul')
  tabs.className = 'tabs'
  for (const tab of session.tabs) {
    const row = document.createElement('li')
    row.className = 'tab'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = text(tab.title || tab.url || 'about:blank')
    name.title = text(tab.url)
    const flags = document.createElement('span')
    flags.className = 'flags'
    flags.textContent = [
      tab.ownership === 'host-created' ? '插件创建' : '用户标签',
      tab.debugged ? '后台调试中' : '',
      tab.active ? '当前可见' : '',
    ]
      .filter(Boolean)
      .join(' · ')
    row.append(name, flags)
    tabs.append(row)
  }

  const actions = document.createElement('div')
  actions.className = 'actions'
  const stopButton = document.createElement('button')
  stopButton.textContent = '停止调试'
  stopButton.onclick = () =>
    run(() => send('task.stop', { sessionId: session.sessionId }))
  const closeButton = document.createElement('button')
  closeButton.className = 'danger'
  closeButton.textContent = '结束并关闭'
  closeButton.onclick = () =>
    run(() => send('sessions.close', { sessionId: session.sessionId }))
  actions.append(stopButton, closeButton)

  item.append(head, tabs, actions)
  return item
}

async function refresh() {
  try {
    const [sessions] = await Promise.all([send('sessions.list'), send('ping')])
    const tabs = sessions.reduce(
      (total, session) => total + session.tabs.length,
      0,
    )
    $('status').textContent =
      '已连接 CCX · ' +
      sessions.length +
      ' 个会话分组 · ' +
      tabs +
      ' 个后台标签'
    $('sessions').replaceChildren(...sessions.map(sessionNode))
    $('empty').style.display = sessions.length ? 'none' : 'block'
  } catch (error) {
    $('status').textContent = '未连接 CCX（' + text(error?.message) + '）'
    $('sessions').replaceChildren()
    $('empty').style.display = 'none'
  }
}

async function run(task) {
  try {
    await task()
  } catch (error) {
    $('status').textContent = text(error?.message)
  }
  await refresh()
}

$('refresh').onclick = () => refresh()
refresh()
setInterval(refresh, 2000)

import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKSystemMessage } from '@proma/shared'
import { HookLifecycleNotice } from './HookLifecycleNotice'

function render(message: SDKSystemMessage): string {
  return renderToStaticMarkup(
    <Provider store={createStore()}>
      <HookLifecycleNotice message={message} />
    </Provider>,
  )
}

describe('Agent 原生 Hook 生命周期展示', () => {
  test('Given CLI 上报 started 和 progress When 渲染 Then 保留真实 Hook 名称、事件与输出', () => {
    const started = render({
      type: 'system', subtype: 'hook_started', hook_id: 'hook-1',
      hook_name: 'memory-loader', hook_event: 'SessionStart',
    })
    const progress = render({
      type: 'system', subtype: 'hook_progress', hook_id: 'hook-1',
      hook_name: 'memory-loader', hook_event: 'SessionStart',
      output: '正在读取工作记忆', stdout: 'loaded 2 records', stderr: '',
    })

    expect(started).toContain('data-agent-hook-event="hook_started"')
    expect(started).toContain('data-hook-id="hook-1"')
    expect(started).toContain('memory-loader')
    expect(started).toContain('SessionStart')
    expect(progress).toContain('data-agent-hook-event="hook_progress"')
    expect(progress).toContain('正在读取工作记忆')
    expect(progress).toContain('loaded 2 records')
  })

  test('Given CLI 上报失败 response When 渲染 Then 展示原生 outcome、退出码和 stderr', () => {
    const html = render({
      type: 'system', subtype: 'hook_response', hook_id: 'hook-2',
      hook_name: 'lint-check', hook_event: 'PostToolUse', outcome: 'error',
      exit_code: 2, output: '', stdout: '', stderr: 'lint failed',
    })

    expect(html).toContain('data-agent-hook-event="hook_response"')
    expect(html).toContain('Hook 执行失败')
    expect(html).toContain('退出码')
    expect(html).toContain('2')
    expect(html).toContain('lint failed')
  })

  test('Given response 缺少原生 outcome When 渲染 Then 不伪造失败状态', () => {
    expect(render({
      type: 'system', subtype: 'hook_response', hook_id: 'hook-3',
      hook_name: 'unknown', hook_event: 'Stop',
    })).toBe('')
  })
})

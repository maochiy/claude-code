import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DispatchRun, RuntimeTask } from '@proma/shared'
import { projectLocalCliTasks } from '../local-service/task-projection'
import {
  getLatestDispatchRun,
  setDispatchStoreAdapter,
  type DispatchStore,
} from './hermes-dispatcher'

function legacyTask(overrides: Partial<RuntimeTask>): RuntimeTask {
  return {
    id: 'legacy-task',
    title: '旧任务',
    kind: 'implementation',
    runtimeId: 'local-cli',
    harnessId: 'local-cli',
    status: 'waiting_approval',
    dependsOn: [],
    inputArtifactIds: [],
    outputArtifactIds: [],
    requiresUserApproval: true,
    approvalState: 'pending',
    retryCount: 0,
    maxRetries: 2,
    timeoutMs: null,
    prompt: '旧版本遗留任务',
    result: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}

function legacyWaitingRun(): DispatchRun {
  const implementation = legacyTask({ id: 'implementation' })
  const review = legacyTask({
    id: 'review',
    title: '旧审查任务',
    kind: 'review',
    status: 'pending',
    dependsOn: [implementation.id],
    requiresUserApproval: false,
    approvalState: 'not_required',
  })
  return {
    id: 'legacy-waiting-run',
    sessionId: 'session-1',
    workspaceId: null,
    status: 'waiting_user',
    plan: {
      id: 'legacy-plan',
      prompt: '旧计划',
      intent: 'approved_plan_implementation',
      strategyId: 'legacy.hermes',
      graph: {
        id: 'legacy-graph',
        rootTaskId: implementation.id,
        tasks: [implementation, review],
        revision: 3,
        createdAt: 1,
        updatedAt: 1,
      },
      requiresRequirementsConfirmation: false,
      requiresPlanApproval: true,
      generatedBy: 'hermes',
      createdAt: 1,
    },
    artifacts: [],
    approvedTaskIds: [],
    currentTaskId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  }
}

describe('Local CLI 原生编排边界', () => {
  afterEach(() => {
    setDispatchStoreAdapter(undefined)
  })

  test('Given 旧 waiting_user 多节点任务图 When 用户发送批准文本 Then Agent 主链没有宿主续跑入口', () => {
    const run = legacyWaitingRun()
    const store: DispatchStore = { runs: [run], updatedAt: 1 }
    let writes = 0
    setDispatchStoreAdapter({
      read: () => store,
      write: () => { writes += 1 },
    })

    expect(getLatestDispatchRun(run.sessionId)).toEqual(run)
    expect(writes).toBe(0)

    const source = readFileSync(join(import.meta.dir, '..', 'agent-orchestrator.ts'), 'utf8')
    expect(source).not.toContain('runDispatchContinuation')
    expect(source).not.toContain('HermesTaskScheduler')
    expect(source).not.toContain('<hermes_task')
    expect(source).not.toContain('getLatestDispatchRun')
  })

  test('Given 旧任务图仍含历史 Runtime When 查询 Then 保留原执行来源且存储字节不变', () => {
    const run = legacyWaitingRun()
    run.plan.graph.tasks[0] = {
      ...run.plan.graph.tasks[0]!,
      runtimeId: 'pi',
      harnessId: 'codex',
    }
    const store: DispatchStore = { runs: [run], updatedAt: 1 }
    const originalBytes = JSON.stringify(store)
    let writes = 0
    setDispatchStoreAdapter({
      read: () => store,
      write: () => {
        writes += 1
      },
    })

    const migrated = getLatestDispatchRun(run.sessionId)
    expect(migrated?.status).toBe('waiting_user')
    expect(migrated?.approvedTaskIds).toEqual([])
    expect(migrated?.plan.graph.tasks[0]).toMatchObject({
      runtimeId: 'pi',
      harnessId: 'codex',
      status: 'waiting_approval',
      approvalState: 'pending',
    })
    expect(migrated?.plan.graph.tasks[1]?.status).toBe('pending')
    expect(JSON.stringify(store)).toBe(originalBytes)
    expect(writes).toBe(0)
  })

  test('Given 一条新消息 When Agent 启动 Runtime Then 仅保留一个 Local CLI query 调用点', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'agent-orchestrator.ts'), 'utf8')
    expect(source.match(/this\.adapter\.query\(/g)).toHaveLength(1)
  })

  test('Given CLI 返回原生任务快照 When 投影桌面任务图 Then 子代理和依赖仍保持原样', () => {
    const graph = projectLocalCliTasks({
      captured_at: 20,
      tasks: [
        { task_id: 'parent', task_type: 'local_agent', status: 'running', transcript_available: true },
        { task_id: 'child', parent_task_id: 'parent', task_type: 'local_bash', status: 'pending' },
      ],
    }, 'native-session', [{ id: 'todo-1', content: '执行检查', status: 'in_progress', blocks: ['todo-2'], blockedBy: [] }])

    expect(graph.runtimeSessionId).toBe('native-session')
    expect(graph.nodes).toEqual([
      expect.objectContaining({ id: 'parent', kind: 'subagent', status: 'running', transcriptAvailable: true }),
      expect.objectContaining({ id: 'child', parentId: 'parent', kind: 'shell', status: 'queued' }),
    ])
    expect(graph.todos[0]?.blocks).toEqual(['todo-2'])
  })
})

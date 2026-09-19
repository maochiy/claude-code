import { describe, expect, test } from 'bun:test'
import { createAgentRunAcceptance } from './agent-run-acceptance'

describe('Agent 首轮启动确认', () => {
  test('Given Runtime 已持久化首条消息 When 标记接收 Then IPC 立即完成', async () => {
    const acceptance = createAgentRunAcceptance()
    acceptance.accept()
    await expect(acceptance.promise).resolves.toBeUndefined()
  })

  test('Given Runtime 启动前失败 When 返回错误 Then IPC 拒绝且迟到接收不覆盖失败', async () => {
    const acceptance = createAgentRunAcceptance()
    acceptance.reject(new Error('工作目录不可用'))
    acceptance.accept()
    await expect(acceptance.promise).rejects.toThrow('工作目录不可用')
  })

  test('Given Runtime 已接收 When 后续生成失败 Then 不把已发送消息重新变为草稿', async () => {
    const acceptance = createAgentRunAcceptance()
    acceptance.accept()
    acceptance.reject(new Error('模型生成失败'))
    await expect(acceptance.promise).resolves.toBeUndefined()
  })
})

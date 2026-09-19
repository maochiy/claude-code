import { describe, expect, test } from 'bun:test'
import { KeepAwakePolicy, type PowerSaveBlockerPort } from './keep-awake-policy'

function createHarness(): {
  policy: KeepAwakePolicy
  started: Set<number>
  setBattery: (value: boolean) => void
  setAllowBattery: (value: boolean) => void
} {
  let nextId = 1
  let battery = false
  let allowBattery = false
  const started = new Set<number>()
  const blocker: PowerSaveBlockerPort = {
    start: () => {
      const id = nextId++
      started.add(id)
      return id
    },
    stop: (id) => { started.delete(id) },
    isStarted: (id) => started.has(id),
  }
  return {
    policy: new KeepAwakePolicy({
      blocker,
      isOnBatteryPower: () => battery,
      keepAwakeOnBattery: () => allowBattery,
    }),
    started,
    setBattery: (value) => { battery = value },
    setAllowBattery: (value) => { allowBattery = value },
  }
}

describe('会话执行防休眠策略', () => {
  test('Given 使用交流电 When 会话开始和结束 Then 只在执行期间持有 blocker', () => {
    const harness = createHarness()
    harness.policy.setAutoRunning('session-a', true)
    expect(harness.policy.isAwake('session-a')).toBe(true)
    expect(harness.started.size).toBe(1)

    harness.policy.setAutoRunning('session-a', false)
    expect(harness.policy.isAwake('session-a')).toBe(false)
    expect(harness.started.size).toBe(0)
  })

  test('Given 默认不允许电池唤醒 When 切到电池再回交流电 Then 暂停并恢复自动 blocker', () => {
    const harness = createHarness()
    harness.policy.setAutoRunning('session-a', true)

    harness.setBattery(true)
    harness.policy.refreshPowerPolicy()
    expect(harness.policy.isAwake('session-a')).toBe(false)

    harness.setBattery(false)
    harness.policy.refreshPowerPolicy()
    expect(harness.policy.isAwake('session-a')).toBe(true)
  })

  test('Given 用户允许电池唤醒 When 使用电池执行 Then 保持 blocker', () => {
    const harness = createHarness()
    harness.setBattery(true)
    harness.setAllowBattery(true)
    harness.policy.setAutoRunning('session-a', true)
    expect(harness.policy.isAwake('session-a')).toBe(true)
  })

  test('Given 电池会话正在执行 When 用户切换电池偏好 Then 立即启停自动 blocker', () => {
    const harness = createHarness()
    harness.setBattery(true)
    harness.policy.setAutoRunning('session-a', true)
    expect(harness.policy.isAwake('session-a')).toBe(false)

    harness.setAllowBattery(true)
    harness.policy.refreshPowerPolicy()
    expect(harness.policy.isAwake('session-a')).toBe(true)

    harness.setAllowBattery(false)
    harness.policy.refreshPowerPolicy()
    expect(harness.policy.isAwake('session-a')).toBe(false)
  })

  test('Given 用户手动开启 When 自动轮次结束 Then 不关闭手动 blocker', () => {
    const harness = createHarness()
    harness.policy.setManual('session-a', true)
    harness.policy.setAutoRunning('session-a', true)
    harness.policy.setAutoRunning('session-a', false)
    expect(harness.policy.isAwake('session-a')).toBe(true)
  })
})

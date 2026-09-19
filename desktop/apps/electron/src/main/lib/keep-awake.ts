/**
 * 会话级防休眠服务（对齐桌面端「Keep computer awake for this session」）。
 *
 * 自动模式只在 Agent 实际执行期间生效；使用电池时由 keepAwakeOnBattery
 * 决定是否继续阻止休眠。手动会话开关始终优先于自动策略。
 */

import { powerMonitor, powerSaveBlocker } from 'electron'
import { getSettings } from './settings-service'
import { KeepAwakePolicy } from './keep-awake-policy'

const policy = new KeepAwakePolicy({
  blocker: powerSaveBlocker,
  isOnBatteryPower: () => powerMonitor.isOnBatteryPower(),
  keepAwakeOnBattery: () => getSettings().keepAwakeOnBattery === true,
  log: (message) => console.log(message),
})

let powerPolicyInitialized = false

function refreshPowerPolicy(): void {
  policy.refreshPowerPolicy()
}

/** 在 app ready 后监听 AC/电池切换。重复调用不会重复注册。 */
export function initializeKeepAwakePowerPolicy(): void {
  if (powerPolicyInitialized) return
  powerPolicyInitialized = true
  powerMonitor.on('on-ac', refreshPowerPolicy)
  powerMonitor.on('on-battery', refreshPowerPolicy)
}

/** 设置变化后立即重算运行中的自动会话。 */
export function refreshAutoKeepAwakePowerPolicy(): void {
  policy.refreshPowerPolicy()
}

/** 切换指定会话的手动防休眠状态，返回实际状态。 */
export function setSessionKeepAwake(sessionId: string, enabled: boolean): boolean {
  return policy.setManual(sessionId, enabled)
}

/** 会话运行期间自动防休眠，由现有 Agent 运行生命周期调用。 */
export function setAutoKeepAwakeWhileWorking(sessionId: string, enabled: boolean): void {
  policy.setAutoRunning(sessionId, enabled)
}

export function isSessionKeepAwake(sessionId: string): boolean {
  return policy.isAwake(sessionId)
}

/** 退出前清理监听器和全部 blocker。 */
export function stopAllKeepAwakeBlockers(): void {
  if (powerPolicyInitialized) {
    powerMonitor.removeListener('on-ac', refreshPowerPolicy)
    powerMonitor.removeListener('on-battery', refreshPowerPolicy)
    powerPolicyInitialized = false
  }
  policy.stopAll()
}

/**
 * 会话防休眠策略核心。
 *
 * 与 Electron 解耦，便于验证电源切换和手动/自动开关的优先级。
 */

export interface PowerSaveBlockerPort {
  start: (type: 'prevent-app-suspension') => number
  stop: (id: number) => void
  isStarted: (id: number) => boolean
}

export interface KeepAwakePolicyOptions {
  blocker: PowerSaveBlockerPort
  isOnBatteryPower: () => boolean
  keepAwakeOnBattery: () => boolean
  log?: (message: string) => void
}

interface SessionBlocker {
  id: number
  source: 'manual' | 'auto'
}

export class KeepAwakePolicy {
  private readonly blockers = new Map<string, SessionBlocker>()
  private readonly autoRunningSessions = new Set<string>()

  constructor(private readonly options: KeepAwakePolicyOptions) {}

  setManual(sessionId: string, enabled: boolean): boolean {
    this.autoRunningSessions.delete(sessionId)
    const existing = this.blockers.get(sessionId)

    if (enabled) {
      if (existing && this.options.blocker.isStarted(existing.id)) {
        existing.source = 'manual'
        return true
      }
      this.start(sessionId, 'manual')
      return true
    }

    this.stop(sessionId)
    return false
  }

  setAutoRunning(sessionId: string, enabled: boolean): void {
    const existing = this.blockers.get(sessionId)
    if (enabled) {
      // 用户手动开启时保持手动所有权，轮次结束不能替用户关闭。
      if (existing?.source === 'manual') return
      this.autoRunningSessions.add(sessionId)
      this.reconcileSession(sessionId)
      return
    }

    this.autoRunningSessions.delete(sessionId)
    if (existing?.source === 'auto') this.stop(sessionId)
  }

  /** 电源来源或电池偏好变化时重算所有正在执行的自动会话。 */
  refreshPowerPolicy(): void {
    for (const sessionId of this.autoRunningSessions) {
      this.reconcileSession(sessionId)
    }
  }

  isAwake(sessionId: string): boolean {
    const blocker = this.blockers.get(sessionId)
    return blocker !== undefined && this.options.blocker.isStarted(blocker.id)
  }

  stopAll(): void {
    for (const sessionId of [...this.blockers.keys()]) this.stop(sessionId)
    this.autoRunningSessions.clear()
  }

  private reconcileSession(sessionId: string): void {
    const shouldBlock = !this.options.isOnBatteryPower() || this.options.keepAwakeOnBattery()
    const existing = this.blockers.get(sessionId)
    if (shouldBlock) {
      if (!existing || !this.options.blocker.isStarted(existing.id)) {
        this.start(sessionId, 'auto')
      }
      return
    }

    if (existing?.source === 'auto') this.stop(sessionId)
  }

  private start(sessionId: string, source: SessionBlocker['source']): void {
    const id = this.options.blocker.start('prevent-app-suspension')
    this.blockers.set(sessionId, { id, source })
    this.options.log?.(`[防休眠] ${source === 'auto' ? '会话运行自动开启' : '已开启'}: sessionId=${sessionId}, blocker=${id}`)
  }

  private stop(sessionId: string): void {
    const blocker = this.blockers.get(sessionId)
    if (!blocker) return
    if (this.options.blocker.isStarted(blocker.id)) this.options.blocker.stop(blocker.id)
    this.blockers.delete(sessionId)
    this.options.log?.(`[防休眠] 已关闭: sessionId=${sessionId}`)
  }
}

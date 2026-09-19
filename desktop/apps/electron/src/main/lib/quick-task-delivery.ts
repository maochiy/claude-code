import { randomUUID } from 'node:crypto'
import type {
  QuickTaskOpenSessionClaim,
  QuickTaskOpenSessionClaimResult,
  QuickTaskOpenSessionData,
  QuickTaskSubmitInput,
} from '../../types'

interface PendingDelivery {
  requestId: string
  submissionId: string
  acknowledgement: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class QuickTaskDeliveryCoordinator {
  private readonly pendingBySubmission = new Map<string, PendingDelivery>()
  private readonly pendingByRequest = new Map<string, PendingDelivery>()
  private readonly committedSubmissions = new Set<string>()

  constructor(private readonly timeoutMs = 10_000) {}

  create(input: QuickTaskSubmitInput): {
    delivery?: QuickTaskOpenSessionData
    acknowledgement: Promise<void>
  } {
    if (this.committedSubmissions.has(input.submissionId)) {
      return { acknowledgement: Promise.resolve() }
    }
    const existing = this.pendingBySubmission.get(input.submissionId)
    if (existing) return { acknowledgement: existing.acknowledgement }

    const requestId = randomUUID()
    let resolveAcknowledgement!: () => void
    let rejectAcknowledgement!: (error: Error) => void
    const acknowledgement = new Promise<void>((resolve, reject) => {
      resolveAcknowledgement = resolve
      rejectAcknowledgement = reject
    })
    let pending!: PendingDelivery
    const timer = setTimeout(() => {
      this.removePending(pending)
      pending.reject(new Error('主窗口准备快速任务超时，草稿未发送'))
    }, this.timeoutMs)
    pending = {
      requestId,
      submissionId: input.submissionId,
      acknowledgement,
      resolve: resolveAcknowledgement,
      reject: rejectAcknowledgement,
      timer,
    }
    this.pendingBySubmission.set(input.submissionId, pending)
    this.pendingByRequest.set(requestId, pending)
    void acknowledgement.catch(() => {})
    return {
      delivery: { requestId, ...input },
      acknowledgement,
    }
  }

  /** 仅允许当前仍有效的请求写入恢复记录，避免超时请求覆盖新重试。 */
  canPrepare(requestId: string, submissionId: string): boolean {
    const pending = this.pendingByRequest.get(requestId)
    return pending != null
      && pending.submissionId === submissionId
      && this.pendingBySubmission.get(submissionId) === pending
  }

  claim(claim: QuickTaskOpenSessionClaim): QuickTaskOpenSessionClaimResult {
    if (this.committedSubmissions.has(claim.submissionId)) {
      return { commit: false, alreadyCommitted: true, error: '该快速任务已经提交' }
    }
    const pending = this.pendingByRequest.get(claim.requestId)
    if (!pending || pending.submissionId !== claim.submissionId
      || this.pendingBySubmission.get(claim.submissionId) !== pending) {
      return { commit: false, error: '快速任务提交许可已过期' }
    }
    this.removePending(pending)
    if (!claim.prepared) {
      pending.reject(new Error(claim.error || '主窗口未能准备快速任务'))
      return { commit: false, error: claim.error || '主窗口未能准备快速任务' }
    }
    this.rememberCommitted(claim.submissionId)
    pending.resolve()
    return { commit: true }
  }

  fail(requestId: string, error: Error): boolean {
    const pending = this.pendingByRequest.get(requestId)
    if (!pending) return false
    this.removePending(pending)
    pending.reject(error)
    return true
  }

  private removePending(pending: PendingDelivery): void {
    if (this.pendingByRequest.get(pending.requestId) === pending) {
      this.pendingByRequest.delete(pending.requestId)
    }
    if (this.pendingBySubmission.get(pending.submissionId) === pending) {
      this.pendingBySubmission.delete(pending.submissionId)
    }
    clearTimeout(pending.timer)
  }

  private rememberCommitted(submissionId: string): void {
    this.committedSubmissions.add(submissionId)
    if (this.committedSubmissions.size <= 1_000) return
    const oldest = this.committedSubmissions.values().next().value
    if (typeof oldest === 'string') this.committedSubmissions.delete(oldest)
  }
}

import type { JsonValue } from '@proma/desktop-protocol'

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: JsonValue,
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

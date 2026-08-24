/** Typed error taxonomy. Errors are values; every one carries enough structure
 *  for the data-quality engine to reason about it. */

export type ProviderErrorKind =
  | 'rate_limited'
  | 'unauthorized'
  | 'not_found'
  | 'upstream_unavailable'
  | 'timeout'
  | 'schema_mismatch'
  | 'unsupported_capability'
  | 'unknown'

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind
  readonly providerId: string
  readonly retryable: boolean
  readonly retryAfterMs: number | null
  readonly detail: string | null

  constructor(params: {
    kind: ProviderErrorKind
    providerId: string
    message: string
    retryAfterMs?: number | null
    detail?: string | null
  }) {
    super(params.message)
    this.name = 'ProviderError'
    this.kind = params.kind
    this.providerId = params.providerId
    this.retryAfterMs = params.retryAfterMs ?? null
    this.detail = params.detail ?? null
    this.retryable =
      params.kind === 'rate_limited' ||
      params.kind === 'upstream_unavailable' ||
      params.kind === 'timeout'
  }
}

/** Raised when a model cannot run — surfaces as an abstention, not a 50% vote. */
export class InsufficientDataError extends Error {
  readonly required: string
  constructor(required: string, message?: string) {
    super(message ?? `Insufficient data: ${required}`)
    this.name = 'InsufficientDataError'
    this.required = required
  }
}

/** Raised when an internal invariant is violated. This is a bug, so it throws. */
export class InvariantError extends Error {
  constructor(message: string) {
    super(`Invariant violated: ${message}`)
    this.name = 'InvariantError'
  }
}

export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new InvariantError(message)
}

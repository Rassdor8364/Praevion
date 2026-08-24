/**
 * Shared HTTP client for provider adapters.
 *
 * Handles timeouts, bounded retry with exponential backoff and jitter, a
 * client-side token bucket so we stop before the upstream rate-limits us, and —
 * crucially — zod validation of every response. An upstream schema change must
 * fail loudly as `schema_mismatch` rather than silently feeding `undefined`
 * into a probability calculation.
 */

import type { ZodType } from 'zod'
import { ProviderError, type ProviderErrorKind } from '@/core/errors'
import { err, ok, type Result } from '@/core/result'

export interface RateLimitConfig {
  /** Requests permitted per window. */
  readonly capacity: number
  /** Window length in ms. */
  readonly windowMs: number
}

class TokenBucket {
  private tokens: number
  private lastRefill: number

  constructor(private readonly config: RateLimitConfig) {
    this.tokens = config.capacity
    this.lastRefill = Date.now()
  }

  /** Wait until a token is available, then consume it. */
  async acquire(): Promise<void> {
    for (;;) {
      this.refill()
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const waitMs = Math.ceil(this.config.windowMs / this.config.capacity)
      await sleep(waitMs)
    }
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    if (elapsed <= 0) return
    const refillRate = this.config.capacity / this.config.windowMs
    this.tokens = Math.min(this.config.capacity, this.tokens + elapsed * refillRate)
    this.lastRefill = now
  }
}

const buckets = new Map<string, TokenBucket>()

function bucketFor(providerId: string, config: RateLimitConfig): TokenBucket {
  let b = buckets.get(providerId)
  if (!b) {
    b = new TokenBucket(config)
    buckets.set(providerId, b)
  }
  return b
}

export interface FetchJsonParams<T> {
  readonly providerId: string
  readonly url: string
  readonly schema: ZodType<T>
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly retries?: number
  readonly rateLimit?: RateLimitConfig
  /** Cache hint for Next.js fetch. Time-sensitive data must pass 0. */
  readonly revalidateSeconds?: number
}

export async function fetchJson<T>(params: FetchJsonParams<T>): Promise<Result<T, ProviderError>> {
  const {
    providerId,
    url,
    schema,
    headers = {},
    timeoutMs = 10_000,
    retries = 2,
    rateLimit,
    revalidateSeconds = 0,
  } = params

  if (rateLimit) await bucketFor(providerId, rateLimit).acquire()

  let lastError: ProviderError | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with full jitter — synchronised retries from many
      // workers are how a transient blip becomes a sustained outage.
      const base = Math.min(8_000, 300 * 2 ** attempt)
      await sleep(Math.random() * base)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', ...headers },
        signal: controller.signal,
        next: { revalidate: revalidateSeconds },
      })
      clearTimeout(timer)

      if (!response.ok) {
        const kind = mapStatus(response.status)
        const retryAfter = response.headers.get('retry-after')
        lastError = new ProviderError({
          kind,
          providerId,
          message: `${providerId} responded ${response.status}`,
          retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : null,
          detail: (await safeText(response)).slice(0, 400),
        })
        if (!lastError.retryable) return err(lastError)
        continue
      }

      const json: unknown = await response.json()
      const parsed = schema.safeParse(json)
      if (!parsed.success) {
        // A schema mismatch is never retried — the upstream contract changed and
        // hammering it will not fix that.
        return err(
          new ProviderError({
            kind: 'schema_mismatch',
            providerId,
            message: `${providerId} returned an unexpected payload shape`,
            detail: parsed.error.issues
              .slice(0, 5)
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
          }),
        )
      }

      return ok(parsed.data)
    } catch (e) {
      clearTimeout(timer)
      const aborted = e instanceof Error && e.name === 'AbortError'
      lastError = new ProviderError({
        kind: aborted ? 'timeout' : 'upstream_unavailable',
        providerId,
        message: aborted ? `${providerId} timed out after ${timeoutMs}ms` : `${providerId} request failed`,
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return err(
    lastError ??
      new ProviderError({ kind: 'unknown', providerId, message: `${providerId} failed with no error` }),
  )
}

/** Fetch plain text (used by the RSS adapter). Same retry/timeout semantics. */
export async function fetchText(params: {
  providerId: string
  url: string
  headers?: Readonly<Record<string, string>>
  timeoutMs?: number
  retries?: number
  rateLimit?: RateLimitConfig
}): Promise<Result<string, ProviderError>> {
  const { providerId, url, headers = {}, timeoutMs = 10_000, retries = 2, rateLimit } = params
  if (rateLimit) await bucketFor(providerId, rateLimit).acquire()

  let lastError: ProviderError | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.random() * Math.min(8_000, 300 * 2 ** attempt))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/rss+xml, application/xml, text/xml, */*', ...headers },
        signal: controller.signal,
        next: { revalidate: 0 },
      })
      clearTimeout(timer)
      if (!response.ok) {
        const kind = mapStatus(response.status)
        lastError = new ProviderError({
          kind,
          providerId,
          message: `${providerId} responded ${response.status}`,
        })
        if (!lastError.retryable) return err(lastError)
        continue
      }
      return ok(await response.text())
    } catch (e) {
      clearTimeout(timer)
      const aborted = e instanceof Error && e.name === 'AbortError'
      lastError = new ProviderError({
        kind: aborted ? 'timeout' : 'upstream_unavailable',
        providerId,
        message: `${providerId} request failed`,
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return err(
    lastError ?? new ProviderError({ kind: 'unknown', providerId, message: `${providerId} failed` }),
  )
}

function mapStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'upstream_unavailable'
  return 'unknown'
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

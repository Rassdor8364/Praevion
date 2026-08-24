/**
 * Provider registry with ordered fallback chains.
 *
 * The registry is the only place that knows which vendor is preferred for which
 * capability, and it is the origin of `dataMode`. Two rules are enforced here
 * and nowhere else:
 *
 *   1. Demo providers are registered ONLY when VIXERA_ALLOW_DEMO is enabled.
 *   2. Whatever provider actually answered is recorded in the provenance that
 *      travels with the data all the way to the screen.
 */

import { ProviderError } from '@/core/errors'
import { err, type Result } from '@/core/result'
import type {
  Capability,
  CryptoProvider,
  NewsProvider,
  Provider,
  ProviderResult,
  SportsProvider,
} from './types'

export interface AttemptRecord {
  readonly providerId: string
  readonly ok: boolean
  readonly errorKind: string | null
}

export interface ResolvedFetch<T> {
  readonly result: ProviderResult<T>
  /** Every provider tried, in order — the fallback audit trail. */
  readonly attempts: readonly AttemptRecord[]
}

export class ProviderRegistry {
  private readonly chains = new Map<Capability, Provider[]>()

  register(provider: Provider): void {
    if (provider.isDemo && !demoAllowed()) return
    if (!provider.isDemo && !provider.isConfigured()) return
    for (const capability of provider.capabilities) {
      const chain = this.chains.get(capability) ?? []
      chain.push(provider)
      this.chains.set(capability, chain)
    }
  }

  /** Providers for a capability, in preference order. */
  chain(capability: Capability): readonly Provider[] {
    return this.chains.get(capability) ?? []
  }

  has(capability: Capability): boolean {
    return (this.chains.get(capability)?.length ?? 0) > 0
  }

  /**
   * Try each provider in order until one succeeds.
   *
   * A provider that throws is treated as a failure and the chain continues — but
   * if EVERY provider fails, the error is returned. There is no synthetic
   * fallback value: the caller must render "Data unavailable" and take the
   * data-quality hit.
   */
  async resolve<T>(
    capability: Capability,
    call: (provider: Provider) => Promise<ProviderResult<T>>,
  ): Promise<ResolvedFetch<T>> {
    const chain = this.chain(capability)
    const attempts: AttemptRecord[] = []

    if (chain.length === 0) {
      return {
        result: err(
          new ProviderError({
            kind: 'unsupported_capability',
            providerId: 'registry',
            message: `No provider registered for capability "${capability}"`,
          }),
        ),
        attempts,
      }
    }

    let lastError: ProviderError | null = null

    for (const provider of chain) {
      try {
        const result = await call(provider)
        // Narrow on the discriminant directly: `isOk` is a generic type guard
        // and TypeScript will not exclude the error arm of a generic union
        // through it, so `.ok` is used here instead.
        if (result.ok) {
          attempts.push({ providerId: provider.id, ok: true, errorKind: null })
          return { result, attempts }
        }
        lastError = result.error
        attempts.push({ providerId: provider.id, ok: false, errorKind: result.error.kind })
      } catch (e) {
        lastError = new ProviderError({
          kind: 'unknown',
          providerId: provider.id,
          message: `${provider.id} threw during ${capability}`,
          detail: e instanceof Error ? e.message : String(e),
        })
        attempts.push({ providerId: provider.id, ok: false, errorKind: 'unknown' })
      }
    }

    return {
      result: err(
        lastError ??
          new ProviderError({
            kind: 'unknown',
            providerId: 'registry',
            message: `All providers failed for ${capability}`,
          }),
      ),
      attempts,
    }
  }

  crypto(capability: Capability): readonly CryptoProvider[] {
    return this.chain(capability) as readonly CryptoProvider[]
  }

  sports(capability: Capability): readonly SportsProvider[] {
    return this.chain(capability) as readonly SportsProvider[]
  }

  news(capability: Capability): readonly NewsProvider[] {
    return this.chain(capability) as readonly NewsProvider[]
  }

  async healthReport(): Promise<Record<string, { healthy: boolean; latencyMs: number | null }>> {
    const seen = new Map<string, Provider>()
    for (const chain of this.chains.values()) {
      for (const p of chain) seen.set(p.id, p)
    }
    const entries = await Promise.all(
      [...seen.values()].map(async (p) => {
        const h = await p.health()
        return [p.id, { healthy: h.healthy, latencyMs: h.latencyMs }] as const
      }),
    )
    return Object.fromEntries(entries)
  }
}

/**
 * Demo providers are gated on an explicit opt-in AND on not being in
 * production. Both conditions must hold. A production deployment cannot serve
 * demo numbers even if someone sets the flag by accident.
 */
export function demoAllowed(): boolean {
  if (process.env.NODE_ENV === 'production' && process.env.VIXERA_ALLOW_DEMO_IN_PROD !== 'true') {
    return false
  }
  return process.env.VIXERA_ALLOW_DEMO === 'true'
}

/** Convert a failed capability into a provenance marker the builder reads as 'partial'. */
export function missingCapabilityMarker(capability: Capability): string {
  return `missing:${capability}`
}

export function unwrapProvider<T>(r: Result<T, ProviderError>): T | null {
  return r.ok ? r.value : null
}

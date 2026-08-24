/**
 * Shared server component for the market-list screens (/markets, /markets/kalshi,
 * /markets/polymarket). Fetches directly from the venue providers at request
 * time; the "Vixera coverage" chip marks rows the scanner's models can price.
 */

import { ExternalLink } from 'lucide-react'
import type { PredictionMarket } from '@/core/markets/types'
import { parseCryptoThreshold } from '@/engines/markets/event-models/crypto-threshold'
import { getMarketProviders } from '@/providers'
import { getRegistry } from '@/providers'
import { DataModeBanner } from '@/ui/DataModeBanner'
import { DisclaimerFooter } from '@/ui/DisclaimerFooter'
import { EmptyState } from '@/ui/EmptyState'
import { ErrorState } from '@/ui/ErrorState'
import { Panel } from '@/ui/Panel'
import { cn, formatPct, formatUsdCompact, formatUtcShort } from '@/ui/lib'

export interface MarketListScreenProps {
  /** Restrict to one venue's provider id; undefined = all venues. */
  readonly venue?: 'kalshi' | 'polymarket'
  readonly heading: string
}

interface VenueFetch {
  readonly venueId: string
  readonly markets: readonly PredictionMarket[]
  readonly isDemo: boolean
  readonly error: string | null
}

async function fetchVenues(venue?: string): Promise<readonly VenueFetch[]> {
  const providers = getMarketProviders(getRegistry()).filter(
    (p) => venue === undefined || p.id === venue,
  )
  return Promise.all(
    providers.map(async (p): Promise<VenueFetch> => {
      const r = await p.getMarkets({ limit: 50 })
      if (!r.ok) return { venueId: p.id, markets: [], isDemo: p.isDemo, error: r.error.message }
      return {
        venueId: p.id,
        markets: r.value.data.markets,
        isDemo: r.value.provenance.isDemo,
        error: null,
      }
    }),
  )
}

function MarketRow({ market }: { readonly market: PredictionMarket }) {
  const primary = market.outcomes[0]
  const covered = parseCryptoThreshold(market.title, market.description) !== null
  return (
    <tr className="border-b border-vx-border last:border-b-0 hover:bg-white/[0.02]">
      <td className="max-w-md py-2 pr-3">
        <div className="flex items-center gap-2">
          {market.url !== null ? (
            <a
              href={market.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 items-center gap-1.5 text-xs text-vx-heading hover:text-vx-accent"
              title={market.title}
            >
              <span className="truncate">{market.title}</span>
              <ExternalLink size={11} className="shrink-0 text-vx-caption" aria-hidden />
            </a>
          ) : (
            <span className="truncate text-xs text-vx-heading" title={market.title}>
              {market.title}
            </span>
          )}
          {covered && (
            <span className="shrink-0 rounded border border-cyan-400/25 bg-cyan-400/[0.06] px-1.5 py-px text-[9px] uppercase tracking-[0.12em] text-vx-live">
              Vixera coverage
            </span>
          )}
        </div>
      </td>
      <td className="py-2 pr-3">
        <span className="text-[10px] uppercase tracking-[0.12em] text-vx-caption">{market.category}</span>
      </td>
      <td className="vx-num py-2 pr-3 text-right text-xs text-vx-heading">
        {primary !== undefined ? formatPct(primary.marketProbability) : '—'}
      </td>
      <td className="vx-num py-2 pr-3 text-right text-xs text-vx-body">{formatUsdCompact(market.volume)}</td>
      <td className="vx-num py-2 pr-3 text-right text-xs text-vx-body">
        {market.spread !== null ? formatPct(market.spread) : '—'}
      </td>
      <td className="vx-num py-2 pr-3 text-right text-[11px] text-vx-caption">
        {formatUtcShort(market.closeTime)}
      </td>
      <td className="py-2 text-right">
        <span className="rounded border border-vx-border-strong px-1.5 py-px text-[9px] uppercase tracking-[0.14em] text-vx-body">
          {market.provider}
        </span>
      </td>
    </tr>
  )
}

export async function MarketListScreen({ venue, heading }: MarketListScreenProps) {
  const venues = await fetchVenues(venue)
  const anyDemo = venues.some((v) => v.isDemo && v.markets.length > 0)
  const allMarkets = venues.flatMap((v) => v.markets)
  const errors = venues.filter((v) => v.error !== null)

  return (
    <div className="space-y-5">
      <DataModeBanner mode={anyDemo ? 'demo' : errors.length > 0 && allMarkets.length > 0 ? 'partial' : 'live'} />
      <Panel
        title={heading}
        right={<span className="vx-num">{allMarkets.length} markets</span>}
        padded
      >
        {errors.map((v) => (
          <ErrorState key={v.venueId} compact title={v.venueId} message={v.error ?? ''} className="mb-2" />
        ))}
        {allMarkets.length === 0 && errors.length === 0 ? (
          <EmptyState title="No open markets returned" detail="The venue listing came back empty." />
        ) : allMarkets.length === 0 ? (
          <EmptyState title="Data unavailable" detail="Every venue request failed — see errors above." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse">
              <thead>
                <tr className="border-b border-vx-border-strong text-left">
                  {['Market', 'Category', 'Market %', 'Volume', 'Spread', 'Closes', 'Venue'].map((h, i) => (
                    <th
                      key={h}
                      className={cn(
                        'py-2 pr-3 text-[10px] font-medium uppercase tracking-[0.16em] text-vx-caption',
                        i >= 2 && 'text-right',
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allMarkets.map((m) => (
                  <MarketRow key={m.id} market={m} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <DisclaimerFooter />
    </div>
  )
}

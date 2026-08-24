import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getIntelligenceEngine } from '@/engines/orchestrator'
import { ALL_CRYPTO_TIMEFRAMES, type Timeframe } from '@/core/prediction/types'
import { DataFreshness } from '@/ui/DataFreshness'
import { DisclaimerFooter } from '@/ui/DisclaimerFooter'
import { ErrorState } from '@/ui/ErrorState'
import { Panel } from '@/ui/Panel'
import { PredictionCard } from '@/ui/PredictionCard'
import { ScenarioBands } from '@/ui/ScenarioBands'
import { Stat } from '@/ui/Stat'
import { cn, formatPct, formatUsd, formatUsdCompact } from '@/ui/lib'

export const dynamic = 'force-dynamic'

const TAB_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'] as const
const SYMBOL_RE = /^[A-Z0-9]{5,20}$/

interface PageProps {
  readonly params: Promise<{ symbol: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { symbol } = await params
  return { title: `${symbol.toUpperCase()} — Crypto` }
}

function SymbolTabs({ active }: { readonly active: string }) {
  return (
    <nav aria-label="Crypto assets" className="flex flex-wrap gap-1 border-b border-vx-border pb-px">
      {TAB_SYMBOLS.map((s) => {
        const isActive = s === active
        return (
          <Link
            key={s}
            href={`/crypto/${s}`}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'vx-num border-b-2 px-3 py-1.5 text-xs transition-colors',
              isActive
                ? 'border-vx-accent text-vx-heading'
                : 'border-transparent text-vx-body hover:text-vx-heading',
            )}
          >
            {s.replace(/USDT$/, '')}
          </Link>
        )
      })}
    </nav>
  )
}

export default async function CryptoSymbolPage({ params }: PageProps) {
  const raw = (await params).symbol.toUpperCase()
  if (!SYMBOL_RE.test(raw)) notFound()

  const engine = getIntelligenceEngine()
  const result = await engine.predictCryptoAllTimeframes(raw)

  if (!result.ok) {
    return (
      <div className="space-y-5">
        <SymbolTabs active={raw} />
        <Panel>
          <ErrorState message={result.error.message} />
        </Panel>
        <DisclaimerFooter />
      </div>
    )
  }

  const bundle = result.value
  const day = bundle.predictions['24h']
  const market = bundle.market

  return (
    <div className="space-y-5">
      <SymbolTabs active={raw} />

      {/* Price header */}
      <Panel padded>
        {market !== null ? (
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <span className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">{market.symbol}</span>
              <div className="flex items-baseline gap-3">
                <span className="vx-num text-2xl font-semibold text-vx-heading">{formatUsd(market.price)}</span>
                <span
                  className={cn(
                    'vx-num text-sm',
                    market.change24hPct > 0
                      ? 'text-vx-pos'
                      : market.change24hPct < 0
                        ? 'text-vx-neg'
                        : 'text-vx-body',
                  )}
                >
                  {market.change24hPct > 0 ? '+' : ''}
                  {market.change24hPct.toFixed(2)}% 24h
                </span>
              </div>
            </div>
            <Stat label="24h high" value={formatUsd(market.high24h)} />
            <Stat label="24h low" value={formatUsd(market.low24h)} />
            <Stat label="24h volume" value={formatUsdCompact(market.quoteVolume24h)} />
            {market.marketCap !== null && <Stat label="Market cap" value={formatUsdCompact(market.marketCap)} />}
            <DataFreshness dataAsOf={new Date(market.timestamp).toISOString()} className="ml-auto self-center" />
          </div>
        ) : (
          <ErrorState compact title="Price header" message="crypto.market unavailable from all providers" />
        )}
      </Panel>

      {/* Multi-timeframe grid — each horizon is an independent prediction. */}
      <Panel title="Multi-Timeframe Outlook" padded>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ALL_CRYPTO_TIMEFRAMES.map((tf: Timeframe) => {
            const p = bundle.predictions[tf]
            if (p === undefined) {
              return (
                <div key={tf} className="vx-glass flex flex-col gap-2 p-3">
                  <span className="vx-num text-[11px] font-medium uppercase tracking-[0.14em] text-vx-heading">
                    {tf}
                  </span>
                  <ErrorState compact title="Unavailable" message="insufficient data for this horizon" />
                </div>
              )
            }
            return <PredictionCard key={tf} prediction={p} compact />
          })}
        </div>
      </Panel>

      {/* 24h deep dive */}
      {day !== undefined ? (
        <>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Panel title="24h Scenarios">
              {day.scenarios !== null && day.scenarios.length > 0 ? (
                <ScenarioBands scenarios={day.scenarios} />
              ) : (
                <p className="py-4 text-xs text-vx-caption">No scenario bands available for this run.</p>
              )}
            </Panel>
            <Panel title="Volatility">
              {day.volatility !== null ? (
                <div className="flex flex-wrap gap-x-8 gap-y-3 py-1">
                  <Stat label="Expected move" value={formatPct(day.volatility.expectedMove)} />
                  <Stat label="Regime" value={day.volatility.regime} />
                  <Stat
                    label="Range"
                    value={
                      market !== null
                        ? `${formatUsd(market.price * (1 + day.volatility.rangeLow))} – ${formatUsd(market.price * (1 + day.volatility.rangeHigh))}`
                        : `${formatPct(day.volatility.rangeLow)} … ${formatPct(day.volatility.rangeHigh)}`
                    }
                  />
                  <Stat label="Forecast confidence" value={formatPct(day.volatility.confidence, 0)} />
                </div>
              ) : (
                <p className="py-4 text-xs text-vx-caption">No volatility forecast available for this run.</p>
              )}
            </Panel>
          </div>

          <PredictionCard prediction={day} />
        </>
      ) : (
        <Panel title="24h Analysis">
          <ErrorState message="The 24h prediction could not be produced for this run." />
        </Panel>
      )}

      {bundle.failures.length > 0 && (
        <Panel title="Degraded Inputs" padded>
          <ul className="space-y-1">
            {bundle.failures.map((f) => (
              <li key={f} className="text-[11px] text-vx-caption">
                {f}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <DisclaimerFooter />
    </div>
  )
}

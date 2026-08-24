/**
 * Betting-market panels for the match detail page.
 *
 * Everything rendered here is read off ONE Dixon–Coles joint distribution
 * (engines/sports/bet-markets), so the numbers are mutually coherent by
 * construction, and the sportsbook panel keeps the §17 trio visibly
 * distinct: raw implied probability, no-vig probability, and Praevion's own
 * probability. Empty states are sentences about what is missing — never a
 * placeholder number.
 */

import type {
  BetMarkets,
  TotalLineProbs,
} from '@/engines/sports/bet-markets'
import type { MatchMarketComparison } from '@/engines/sports/odds-edge'
import { Panel } from '@/ui/Panel'
import { ProbabilityBar } from '@/ui/ProbabilityBar'
import { cn, formatPct, formatSignedPp } from '@/ui/lib'

function fmtOdds(odds: number): string {
  return Number.isFinite(odds) ? odds.toFixed(2) : '—'
}

function fmtLine(line: number): string {
  return line > 0 ? `+${line}` : `${line}`
}

// ---------------------------------------------------------------------------
// Score distribution
// ---------------------------------------------------------------------------

export function ScoreDistributionPanel({
  markets,
  homeName,
  awayName,
}: {
  readonly markets: BetMarkets
  readonly homeName: string
  readonly awayName: string
}) {
  const { correctScores, expectedGoals } = markets
  const max = correctScores.top[0]?.probability ?? 1
  return (
    <Panel title="Score Distribution">
      <p className="mb-3 text-[11px] text-vx-caption">
        Expected goals{' '}
        <span className="text-vx-body">{homeName}</span>{' '}
        <span className="vx-num text-vx-heading">{expectedGoals.home.toFixed(2)}</span>
        {' · '}
        <span className="text-vx-body">{awayName}</span>{' '}
        <span className="vx-num text-vx-heading">{expectedGoals.away.toFixed(2)}</span>
      </p>
      <ul className="space-y-1.5">
        {correctScores.top.map((s) => (
          <li key={`${s.home}-${s.away}`} className="flex items-center gap-3">
            <span className="vx-num w-10 shrink-0 text-xs text-vx-heading">
              {s.home}–{s.away}
            </span>
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.05]"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(s.probability * 100)}
            >
              <div
                className="h-full rounded-full bg-vx-live/70"
                style={{ width: `${(s.probability / max) * 100}%` }}
              />
            </div>
            <span className="vx-num w-12 shrink-0 text-right text-[11px] text-vx-body">
              {formatPct(s.probability)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[10px] text-vx-caption">
        All other scorelines combined: {formatPct(correctScores.otherProbability)}
      </p>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Derived markets
// ---------------------------------------------------------------------------

function TotalsTable({ rows, caption }: { readonly rows: readonly TotalLineProbs[]; readonly caption: string }) {
  return (
    <div>
      <h4 className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-vx-caption">{caption}</h4>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-vx-caption">
            <th className="pb-1 font-normal">Line</th>
            <th className="pb-1 text-right font-normal">Over</th>
            <th className="pb-1 text-right font-normal">Under</th>
            <th className="pb-1 text-right font-normal">Fair O/U</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.line} className="border-t border-vx-border/60">
              <td className="vx-num py-1 text-vx-heading">{t.line}</td>
              <td className="vx-num py-1 text-right text-vx-body">{formatPct(t.over)}</td>
              <td className="vx-num py-1 text-right text-vx-body">{formatPct(t.under)}</td>
              <td className="vx-num py-1 text-right text-vx-caption">
                {fmtOdds(1 / t.over)} / {fmtOdds(1 / t.under)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function DerivedMarketsPanel({
  markets,
  homeName,
  awayName,
}: {
  readonly markets: BetMarkets
  readonly homeName: string
  readonly awayName: string
}) {
  const { doubleChance, drawNoBet, btts } = markets
  // The ladder is long; show the liquid center of it (−2 … +2 is the full
  // set already; keep all, table is compact).
  return (
    <Panel title="Derived Markets — one coherent distribution">
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 lg:grid-cols-2">
        <div className="space-y-2">
          <h4 className="text-[10px] uppercase tracking-[0.14em] text-vx-caption">Double chance</h4>
          <ProbabilityBar value={doubleChance.homeOrDraw} label="1X (home or draw)" compact />
          <ProbabilityBar value={doubleChance.homeOrAway} label="12 (either wins)" compact />
          <ProbabilityBar value={doubleChance.drawOrAway} label="X2 (draw or away)" compact />

          <h4 className="pt-3 text-[10px] uppercase tracking-[0.14em] text-vx-caption">Draw no bet</h4>
          <ProbabilityBar value={drawNoBet.home} label={`${homeName} DNB`} compact fill="violet" />
          <ProbabilityBar value={drawNoBet.away} label={`${awayName} DNB`} compact fill="cyan" />
          <p className="text-[10px] text-vx-caption">
            Conditional on a decisive result; the draw ({formatPct(drawNoBet.pushProbability)}) refunds.
          </p>

          <h4 className="pt-3 text-[10px] uppercase tracking-[0.14em] text-vx-caption">Both teams to score</h4>
          <ProbabilityBar value={btts.yes} label="Yes" compact />
          <ProbabilityBar value={btts.no} label="No" compact />
        </div>

        <div className="space-y-5">
          <TotalsTable rows={markets.totals} caption="Total goals" />
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <TotalsTable rows={markets.homeTeamTotals} caption={`${homeName} goals`} />
            <TotalsTable rows={markets.awayTeamTotals} caption={`${awayName} goals`} />
          </div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-x-8 gap-y-5 lg:grid-cols-2">
        <div>
          <h4 className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-vx-caption">
            Asian handicap ({homeName} line)
          </h4>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-vx-caption">
                <th className="pb-1 font-normal">Line</th>
                <th className="pb-1 text-right font-normal">Home cover</th>
                <th className="pb-1 text-right font-normal">Fair home</th>
                <th className="pb-1 text-right font-normal">Fair away</th>
              </tr>
            </thead>
            <tbody>
              {markets.asianHandicap
                .filter((l) => Math.abs(l.line) <= 1.5)
                .map((l) => {
                  const cover = l.home.fullWin + l.home.halfWin / 2
                  return (
                    <tr key={l.line} className="border-t border-vx-border/60">
                      <td className="vx-num py-1 text-vx-heading">{fmtLine(l.line)}</td>
                      <td className="vx-num py-1 text-right text-vx-body">{formatPct(cover)}</td>
                      <td className="vx-num py-1 text-right text-vx-caption">{fmtOdds(l.homeFairOdds)}</td>
                      <td className="vx-num py-1 text-right text-vx-caption">{fmtOdds(l.awayFairOdds)}</td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
          <p className="mt-1.5 text-[10px] leading-relaxed text-vx-caption">
            Cover = stake-weighted win share (quarter lines split the stake across the adjacent
            lines; pushes refund and are priced into the fair odds).
          </p>
        </div>

        <div>
          <h4 className="mb-1.5 text-[10px] uppercase tracking-[0.14em] text-vx-caption">
            European handicap (3-way)
          </h4>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-vx-caption">
                <th className="pb-1 font-normal">Line</th>
                <th className="pb-1 text-right font-normal">Home</th>
                <th className="pb-1 text-right font-normal">Draw</th>
                <th className="pb-1 text-right font-normal">Away</th>
              </tr>
            </thead>
            <tbody>
              {markets.europeanHandicap.map((l) => (
                <tr key={l.line} className="border-t border-vx-border/60">
                  <td className="vx-num py-1 text-vx-heading">{fmtLine(l.line)}</td>
                  <td className="vx-num py-1 text-right text-vx-body">{formatPct(l.home)}</td>
                  <td className="vx-num py-1 text-right text-vx-body">{formatPct(l.draw)}</td>
                  <td className="vx-num py-1 text-right text-vx-body">{formatPct(l.away)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-4 border-t border-vx-border pt-2 text-[10px] leading-relaxed text-vx-caption">
        Every market above is a partition of the same Dixon–Coles score distribution — 1X2, totals,
        BTTS and handicaps cannot contradict each other. Fair odds are margin-free (1/probability).
      </p>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Sportsbook comparison
// ---------------------------------------------------------------------------

export function SportsbookPanel({
  marketOdds,
}: {
  readonly marketOdds: {
    readonly status: 'ok' | 'unconfigured' | 'unavailable' | 'unmatched'
    readonly comparison: MatchMarketComparison | null
    readonly detail: string | null
  }
}) {
  const { status, comparison } = marketOdds

  if (status !== 'ok' || comparison === null) {
    const message =
      status === 'unconfigured'
        ? 'No sportsbook odds provider configured. Praevion still calculates its independent fair probabilities above; set ODDS_API_KEY to enable market-edge analysis.'
        : status === 'unmatched'
          ? 'This fixture could not be unambiguously matched to a sportsbook event, so no market comparison is shown — a wrong match would be worse than none.'
          : `Sportsbook odds are temporarily unavailable${marketOdds.detail !== null ? `: ${marketOdds.detail}` : '.'}`
    return (
      <Panel title="Sportsbook Comparison">
        <p className="text-xs leading-relaxed text-vx-caption">{message}</p>
      </Panel>
    )
  }

  return (
    <Panel title="Sportsbook Comparison">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-vx-caption">
            <th className="pb-1 font-normal">Outcome</th>
            <th className="pb-1 text-right font-normal">Praevion</th>
            <th className="pb-1 text-right font-normal">Fair</th>
            <th className="pb-1 text-right font-normal">Implied</th>
            <th className="pb-1 text-right font-normal">No-vig</th>
            <th className="pb-1 text-right font-normal">Edge</th>
            <th className="pb-1 text-right font-normal">Best odds</th>
            <th className="pb-1 text-right font-normal">¼-Kelly</th>
          </tr>
        </thead>
        <tbody>
          {comparison.outcomes.map((o) => (
            <tr key={o.key} className="border-t border-vx-border/60">
              <td className="max-w-[9rem] truncate py-1.5 text-vx-heading" title={o.label}>
                {o.label}
              </td>
              <td className="vx-num py-1.5 text-right text-vx-heading">{formatPct(o.vixeraProbability)}</td>
              <td className="vx-num py-1.5 text-right text-vx-caption">{fmtOdds(o.fairOdds)}</td>
              <td className="vx-num py-1.5 text-right text-vx-body">{formatPct(o.impliedProbability)}</td>
              <td className="vx-num py-1.5 text-right text-vx-body">{formatPct(o.noVigProbability)}</td>
              <td
                className={cn(
                  'vx-num py-1.5 text-right',
                  o.edge > 0.005 ? 'text-vx-pos' : o.edge < -0.005 ? 'text-vx-neg' : 'text-vx-caption',
                )}
              >
                {formatSignedPp(o.edge)}
              </td>
              <td className="vx-num py-1.5 text-right text-vx-body" title={o.bestBookmaker}>
                {fmtOdds(o.bestOdds)}
              </td>
              <td className="vx-num py-1.5 text-right text-vx-caption">
                {o.staking === null ? '—' : formatPct(o.staking.adjustedFraction)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 border-t border-vx-border pt-2 text-[10px] leading-relaxed text-vx-caption">
        {comparison.bookmakerCount} bookmaker{comparison.bookmakerCount === 1 ? '' : 's'} · median
        overround {formatPct(comparison.medianOverround)} · collected{' '}
        {new Date(comparison.collectedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC. Implied
        = raw price; no-vig removes the margin (power method); edge compares Praevion to no-vig.
        ¼-Kelly is risk-capped sizing mathematics (2% ceiling) on the best available price — an
        analytical quantity, not a recommendation to wager.
      </p>
    </Panel>
  )
}

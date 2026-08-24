/**
 * AI Analyst briefing composer — the quant-backed narrative layer of plan §81.
 *
 * DETERMINISTIC BY CONSTRUCTION. There is no LLM in this deployment (the seam
 * for one is declared in engines/news/seam.ts per plan §12); every sentence
 * below is composed from already-computed numbers via fixed templates, and
 * every claim carries EVIDENCE refs tracing it to the source system that
 * produced the figure. Variation in the language comes from the DATA (band
 * thresholds on probability and confidence), never from randomness — no
 * Math.random, no Date.now, no hidden state. Same inputs → identical output,
 * which is what makes the whatChanged diff meaningful.
 *
 * LANGUAGE CONTRACT (enforced by tests/analyst/briefing.test.ts):
 *  - hedging is tiered by confidence: <0.35 "weak signal, low conviction",
 *    0.35–0.6 "moderate signal", >0.6 "strong signal";
 *  - certainty words are banned — the composer says "leans", "favors",
 *    "suggests"; never "will", "guaranteed" or "certain";
 *  - no-action opportunities are NEVER promoted — the scanner's gating is
 *    respected verbatim, and a rejected market may only appear as
 *    "flagged but not actionable: <its own stated reason>";
 *  - unverified news clusters are excluded entirely (importance.ts caps them
 *    out of market-signal output; the Analyst repeats that exclusion);
 *  - risk_flags ALWAYS renders — a briefing without caveats is a lie, so the
 *    standing probabilistic caveat is unconditional.
 *
 * Pure: takes already-fetched inputs, returns a structure. All I/O lives in
 * ./orchestrator.ts.
 */

import type { DataMode } from '@/core/prediction/types'
import type { VixeraOpportunity } from '@/core/markets/types'
import { getEntity } from '@/engines/news/entities'
import { MINUTE_MS } from '@/core/clock'

// ---------------------------------------------------------------------------
// Input shapes — deliberately slim projections of the source systems' own
// outputs, so the composer depends on numbers, not on orchestrator plumbing.
// ---------------------------------------------------------------------------

/** One crypto symbol's state, projected from VixeraPrediction + market data. */
export interface CryptoStateInput {
  /** Asset label, e.g. 'BTC'. */
  readonly symbol: string
  /** The prediction id (or symbol) the evidence ref points at. */
  readonly predictionId: string
  readonly timeframe: string
  /** P(up) over the horizon, 0..1 — null when no up/down outcome exists. */
  readonly pUp: number | null
  readonly confidence: number
  readonly modelAgreement: number
  /** 0..100 */
  readonly dataQuality: number
  readonly dataMode: DataMode
  /** ISO — the OLDEST contributing input (VixeraPrediction.dataTimestamp). */
  readonly dataTimestamp: string
  readonly spot: number | null
}

/** One upcoming fixture, projected from the sports board's FixturePrediction. */
export interface SportsFixtureInput {
  readonly gameId: string
  readonly league: string
  readonly home: string
  readonly away: string
  readonly kickoffMs: number
  readonly outcomes: readonly { key: string; label: string; probability: number }[]
  readonly confidence: number
  /** From the league board: < 3 finished rounds behind the current season. */
  readonly earlySeason: boolean
}

/** One story cluster, projected from the news board's ScoredCluster. */
export interface NewsClusterInput {
  readonly id: string
  readonly headline: string
  /** 0..100 */
  readonly importance: number
  readonly isBreaking: boolean
  /** True when no member reaches ESTABLISHED_MEDIA — excluded entirely. */
  readonly unverified: boolean
  readonly sourceCount: number
  readonly entities: readonly {
    readonly entityId: string
    readonly mentions: number
    /** -100..+100 */
    readonly sentimentScore: number
    /** 0..1 */
    readonly sentimentConfidence: number
  }[]
}

export type BriefingDomain = 'crypto' | 'sports' | 'news' | 'edge'

/** A domain (or venue within a domain) that failed to produce inputs. */
export interface DomainFailure {
  readonly domain: BriefingDomain
  readonly message: string
}

export interface BriefingInputs {
  readonly marketState: readonly CryptoStateInput[]
  /** The FULL scan output — actionable and no_action alike. The composer
   *  applies the scanner's own gating; it never re-derives its own. */
  readonly edgeOpportunities: readonly VixeraOpportunity[]
  readonly sportsFixtures: readonly SportsFixtureInput[]
  readonly newsClusters: readonly NewsClusterInput[]
  readonly failures: readonly DomainFailure[]
  /** ISO instant of composition — time enters HERE only. */
  readonly generatedAt: string
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

export type EvidenceSource = 'crypto' | 'sports' | 'news' | 'edge'

/** Every claim carries at least one of these: which system, which object,
 *  which value — the traceability contract of the briefing. */
export interface EvidenceRef {
  readonly source: EvidenceSource
  readonly ref: string
  readonly value: string
}

export interface BriefingLine {
  readonly text: string
  readonly evidence: readonly EvidenceRef[]
}

export type SectionId =
  | 'market_pulse'
  | 'top_opportunities'
  | 'watch_next'
  | 'moving_news'
  | 'risk_flags'

export interface AnalystSection {
  readonly id: SectionId
  readonly title: string
  readonly headline: BriefingLine
  readonly bullets: readonly BriefingLine[]
}

/** Machine-readable snapshot powering whatChanged — diffs run on these, never
 *  on parsed prose. */
export interface BriefingFacts {
  readonly crypto: readonly {
    readonly symbol: string
    readonly direction: 'bullish' | 'bearish' | 'neutral'
    readonly pUp: number | null
    readonly confidence: number
  }[]
  readonly opportunities: readonly {
    /** Stable key: market id + outcome id (evaluation-time-free). */
    readonly key: string
    readonly title: string
    readonly edgePp: number
  }[]
  readonly breakingClusters: readonly { readonly id: string; readonly headline: string }[]
}

export interface AnalystBriefing {
  readonly generatedAt: string
  readonly sections: readonly AnalystSection[]
  readonly facts: BriefingFacts
}

export type BriefingChangeKind =
  | 'new_opportunity'
  | 'removed_opportunity'
  | 'direction_flip'
  | 'confidence_swing'
  | 'new_breaking'

export interface BriefingChange {
  readonly kind: BriefingChangeKind
  readonly text: string
  readonly evidence: readonly EvidenceRef[]
}

export interface BriefingDelta {
  /** generatedAt of the previous briefing, or null when none existed. */
  readonly since: string | null
  readonly changes: readonly BriefingChange[]
}

// ---------------------------------------------------------------------------
// Thresholds (exported so tests and UI name the same numbers)
// ---------------------------------------------------------------------------

/** Sports lean: leading probability must beat the runner-up by this much. */
export const WATCH_LEAN_THRESHOLD = 0.15
/** Fixtures window for watch_next. */
export const WATCH_WINDOW_MS = 72 * 60 * 60 * 1000
/** Confidence swing that whatChanged reports, in probability points. */
export const CONFIDENCE_SWING_THRESHOLD = 0.1
/** Crypto inputs older than this at composition time raise a staleness flag. */
export const STALE_INPUT_MS = 30 * MINUTE_MS
/** Model-pool agreement below this raises a disagreement flag. */
export const DISAGREEMENT_THRESHOLD = 0.5
/** Entity sentiment below this display confidence is "no read", not neutral. */
const SENTIMENT_DISPLAY_CONFIDENCE = 0.4

// ---------------------------------------------------------------------------
// Formatting + hedging vocabulary (all deterministic band lookups)
// ---------------------------------------------------------------------------

function pct(p: number, digits = 1): string {
  return `${(p * 100).toFixed(digits)}%`
}

function pp(p: number, digits = 1): string {
  return `${(p * 100).toFixed(digits)}pp`
}

function fmtHours(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return 'unreported horizon'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`
  if (hours < 48) return `${Math.round(hours)}h`
  return `${(hours / 24).toFixed(1)}d`
}

export type HedgeTier = 'weak' | 'moderate' | 'strong'

/** Confidence → hedging tier. Bands per the language contract above. */
export function hedgeTier(confidence: number): HedgeTier {
  if (confidence < 0.35) return 'weak'
  if (confidence <= 0.6) return 'moderate'
  return 'strong'
}

export function hedgeLabel(confidence: number): string {
  switch (hedgeTier(confidence)) {
    case 'weak':
      return 'weak signal, low conviction'
    case 'moderate':
      return 'moderate signal'
    case 'strong':
      return 'strong signal'
  }
}

/** P(up) → direction phrase. Verbs vary with the DATA — never with RNG. */
function directionPhrase(pUp: number): string {
  if (pUp >= 0.6) return 'favors upside'
  if (pUp > 0.52) return 'leans higher'
  if (pUp >= 0.48) return 'reads near-balanced'
  if (pUp > 0.4) return 'leans lower'
  return 'favors downside'
}

function directionOfPUp(pUp: number | null, neutralBand = 0.02): 'bullish' | 'bearish' | 'neutral' {
  if (pUp === null) return 'neutral'
  if (pUp > 0.5 + neutralBand) return 'bullish'
  if (pUp < 0.5 - neutralBand) return 'bearish'
  return 'neutral'
}

// ---------------------------------------------------------------------------
// Section: market_pulse
// ---------------------------------------------------------------------------

function marketPulseSection(inputs: BriefingInputs): AnalystSection {
  const states = inputs.marketState
  const withP = states.filter((s) => s.pUp !== null)

  if (withP.length === 0) {
    const failed = inputs.failures.some((f) => f.domain === 'crypto')
    return {
      id: 'market_pulse',
      title: 'Market Pulse',
      headline: {
        text: failed
          ? 'No market read this cycle — crypto prediction inputs were unavailable (see risk flags).'
          : 'No market read this cycle — no crypto prediction produced an up/down probability.',
        evidence: [],
      },
      bullets: [],
    }
  }

  const bullish = withP.filter((s) => directionOfPUp(s.pUp) === 'bullish')
  const bearish = withP.filter((s) => directionOfPUp(s.pUp) === 'bearish')
  const meanConf = withP.reduce((a, s) => a + s.confidence, 0) / withP.length

  // Aggregate phrasing varies by the tally, deterministically.
  const shape =
    bullish.length === withP.length
      ? 'aligned to the upside'
      : bearish.length === withP.length
        ? 'aligned to the downside'
        : bullish.length === 0 && bearish.length === 0
          ? 'near-balanced with no decisive lean'
          : 'mixed'
  // Strongest lean: farthest from 0.5.
  const strongest = [...withP].sort(
    (a, b) => Math.abs((b.pUp ?? 0.5) - 0.5) - Math.abs((a.pUp ?? 0.5) - 0.5) || a.symbol.localeCompare(b.symbol),
  )[0] as CryptoStateInput

  const headline: BriefingLine = {
    text:
      `Across ${withP.length} tracked major${withP.length === 1 ? '' : 's'} the ${strongest.timeframe} model set is ${shape}` +
      ` (${bullish.length} bullish / ${bearish.length} bearish / ${withP.length - bullish.length - bearish.length} neutral); ` +
      `the strongest lean is ${strongest.symbol} at P(up) ${pct(strongest.pUp as number)} — ${hedgeLabel(meanConf)} overall.`,
    evidence: withP.map((s) => ({
      source: 'crypto' as const,
      ref: s.predictionId,
      value: `P(up ${s.timeframe})=${pct(s.pUp as number)}`,
    })),
  }

  const bullets: BriefingLine[] = states.map((s) => {
    if (s.pUp === null) {
      return {
        text: `${s.symbol}: no up/down probability available this cycle.`,
        evidence: [{ source: 'crypto', ref: s.predictionId, value: 'no outcome' }],
      }
    }
    return {
      text:
        `${s.symbol}: the ${s.timeframe} model ${directionPhrase(s.pUp)} — P(up) ${pct(s.pUp)}; ` +
        `${hedgeLabel(s.confidence)} (confidence ${s.confidence.toFixed(2)}, model agreement ${s.modelAgreement.toFixed(2)}, data quality ${Math.round(s.dataQuality)}/100).`,
      evidence: [
        { source: 'crypto', ref: s.predictionId, value: `P(up)=${pct(s.pUp)}` },
        { source: 'crypto', ref: s.predictionId, value: `confidence=${s.confidence.toFixed(2)}` },
      ],
    }
  })

  return { id: 'market_pulse', title: 'Market Pulse', headline, bullets }
}

// ---------------------------------------------------------------------------
// Section: top_opportunities
// ---------------------------------------------------------------------------

function opportunityWhy(o: VixeraOpportunity): string {
  const relation = o.edgePp > 0 ? 'richer' : 'cheaper'
  return `model prices '${o.outcomeName}' ${relation} than the venue by ${pp(Math.abs(o.edgePp))} with ${o.liquidity.grade} liquidity`
}

function topOpportunitiesSection(inputs: BriefingInputs): AnalystSection {
  // The scanner's verdicts are final: only action === 'opportunity' may be
  // promoted. no_action markets appear ONLY as flagged-but-not-actionable.
  const actionable = inputs.edgeOpportunities
    .filter((o) => o.action === 'opportunity')
    .sort((a, b) => b.opportunityScore - a.opportunityScore || a.id.localeCompare(b.id))
    .slice(0, 5)
  const rejected = inputs.edgeOpportunities
    .filter((o) => o.action === 'no_action')
    .sort((a, b) => b.opportunityScore - a.opportunityScore || a.id.localeCompare(b.id))

  const evaluated = inputs.edgeOpportunities.length

  const headline: BriefingLine =
    actionable.length === 0
      ? {
          text:
            evaluated === 0
              ? inputs.failures.some((f) => f.domain === 'edge')
                ? 'No market scan this cycle — edge scanner inputs were unavailable (see risk flags).'
                : 'The edge scanner evaluated no covered markets this cycle.'
              : `No tradeable-grade divergence among ${evaluated} evaluated market${evaluated === 1 ? '' : 's'} — every one was fairly priced or failed an action gate. "Nothing here" is itself a finding.`,
          evidence: [],
        }
      : {
          text:
            `${actionable.length} tradeable-grade divergence${actionable.length === 1 ? '' : 's'} out of ${evaluated} evaluated; ` +
            `the largest gap is ${pp(Math.abs((actionable[0] as VixeraOpportunity).edgePp))} on "${(actionable[0] as VixeraOpportunity).market.title}".`,
          evidence: actionable.map((o) => ({
            source: 'edge' as const,
            ref: o.market.id,
            value: `edge=${pp(o.edgePp)}`,
          })),
        }

  const bullets: BriefingLine[] = actionable.map((o) => ({
    text:
      `${o.market.title} — market ${pct(o.marketProbability)} vs Vixera ${pct(o.vixeraProbability)}: ` +
      `model diverges from market by ${pp(Math.abs(o.edgePp))} (score ${o.opportunityScore.toFixed(0)}, confidence ${o.confidence.toFixed(2)}, resolves ${fmtHours(o.hoursToResolution)}); ` +
      `why: ${opportunityWhy(o)}.`,
    evidence: [
      { source: 'edge', ref: o.market.id, value: `edge=${pp(o.edgePp)}` },
      { source: 'edge', ref: o.market.id, value: `score=${o.opportunityScore.toFixed(1)}` },
    ],
  }))

  // Up to two rejected markets, quoted with the scanner's OWN first reason —
  // the Analyst repeats the gate, it never overrides it.
  for (const o of rejected.slice(0, 2)) {
    const reason = o.noActionReasons[0] ?? 'below action thresholds'
    bullets.push({
      text: `Flagged but not actionable: ${o.market.title} — ${reason}.`,
      evidence: [{ source: 'edge', ref: o.market.id, value: 'no_action' }],
    })
  }

  return { id: 'top_opportunities', title: 'Top Opportunities', headline, bullets }
}

// ---------------------------------------------------------------------------
// Section: watch_next
// ---------------------------------------------------------------------------

interface RankedFixture {
  readonly fixture: SportsFixtureInput
  readonly leader: { label: string; probability: number }
  readonly runnerUp: { label: string; probability: number }
  readonly margin: number
}

function rankFixtures(inputs: BriefingInputs): RankedFixture[] {
  const nowMs = Date.parse(inputs.generatedAt)
  const ranked: RankedFixture[] = []
  for (const f of inputs.sportsFixtures) {
    if (f.kickoffMs <= nowMs || f.kickoffMs > nowMs + WATCH_WINDOW_MS) continue
    const sorted = [...f.outcomes].sort((a, b) => b.probability - a.probability)
    const leader = sorted[0]
    const runnerUp = sorted[1]
    if (leader === undefined || runnerUp === undefined) continue
    const margin = leader.probability - runnerUp.probability
    if (margin <= WATCH_LEAN_THRESHOLD) continue
    ranked.push({ fixture: f, leader, runnerUp, margin })
  }
  ranked.sort((a, b) => b.margin - a.margin || a.fixture.gameId.localeCompare(b.fixture.gameId))
  return ranked
}

function watchNextSection(inputs: BriefingInputs): AnalystSection {
  const nowMs = Date.parse(inputs.generatedAt)
  const ranked = rankFixtures(inputs).slice(0, 5)
  const inWindow = inputs.sportsFixtures.filter(
    (f) => f.kickoffMs > nowMs && f.kickoffMs <= nowMs + WATCH_WINDOW_MS,
  ).length

  const headline: BriefingLine =
    ranked.length === 0
      ? {
          text:
            inWindow === 0
              ? inputs.failures.some((f) => f.domain === 'sports')
                ? 'No fixture watch this cycle — sports inputs were unavailable (see risk flags).'
                : 'No covered fixture kicks off inside the next 72h.'
              : `${inWindow} fixture${inWindow === 1 ? '' : 's'} inside 72h, but none carries a model lean above ${pp(WATCH_LEAN_THRESHOLD, 0)} — no strong lean to watch.`,
          evidence: [],
        }
      : {
          text: `${ranked.length} of ${inWindow} fixture${inWindow === 1 ? '' : 's'} in the next 72h carr${ranked.length === 1 ? 'ies' : 'y'} a model lean above ${pp(WATCH_LEAN_THRESHOLD, 0)}.`,
          evidence: ranked.map((r) => ({
            source: 'sports' as const,
            ref: r.fixture.gameId,
            value: `lean=${pp(r.margin)}`,
          })),
        }

  const bullets: BriefingLine[] = ranked.map((r) => {
    const hours = Math.max(0, (r.fixture.kickoffMs - nowMs) / 3_600_000)
    return {
      text:
        `${r.fixture.home} vs ${r.fixture.away} (${r.fixture.league}) — the model favors ${r.leader.label} at ${pct(r.leader.probability)}, ` +
        `${pp(r.margin)} clear of ${r.runnerUp.label}; ${hedgeLabel(r.fixture.confidence)} (confidence ${r.fixture.confidence.toFixed(2)}); kickoff in ${fmtHours(hours)}.`,
      evidence: [
        { source: 'sports', ref: r.fixture.gameId, value: `P(${r.leader.label})=${pct(r.leader.probability)}` },
      ],
    }
  })

  if (ranked.some((r) => r.fixture.earlySeason)) {
    bullets.push({
      text: 'Early-season caveat: current-season samples are thin, so these leans draw heavily on last season’s data and deserve extra skepticism.',
      evidence: ranked
        .filter((r) => r.fixture.earlySeason)
        .map((r) => ({ source: 'sports' as const, ref: r.fixture.gameId, value: 'earlySeason=true' })),
    })
  }

  return { id: 'watch_next', title: 'Watch Next', headline, bullets }
}

// ---------------------------------------------------------------------------
// Section: moving_news
// ---------------------------------------------------------------------------

function toneWord(score: number): string {
  if (score >= 25) return 'positive tone'
  if (score <= -25) return 'negative tone'
  return 'mixed tone'
}

function entityClause(c: NewsClusterInput): { text: string | null; assets: string[] } {
  const parts: string[] = []
  const assets = new Set<string>()
  for (const e of [...c.entities].sort((a, b) => b.mentions - a.mentions).slice(0, 3)) {
    const definition = getEntity(e.entityId)
    const name = definition?.name ?? e.entityId
    const related = definition?.relatedAssets ?? []
    for (const a of related) assets.add(a)
    const sentiment =
      e.sentimentConfidence >= SENTIMENT_DISPLAY_CONFIDENCE
        ? `${toneWord(e.sentimentScore)} ${e.sentimentScore > 0 ? '+' : ''}${Math.round(e.sentimentScore)}`
        : 'no sentiment read'
    const link = related.length > 0 ? ` → ${related.join('/')}` : ''
    parts.push(`${name} (${sentiment})${link}`)
  }
  return { text: parts.length === 0 ? null : parts.join('; '), assets: [...assets] }
}

function movingNewsSection(inputs: BriefingInputs): AnalystSection {
  // Unverified clusters are excluded ENTIRELY — not down-ranked, absent.
  const verified = inputs.newsClusters.filter((c) => !c.unverified)
  const ordered = [...verified].sort(
    (a, b) =>
      Number(b.isBreaking) - Number(a.isBreaking) ||
      b.importance - a.importance ||
      a.id.localeCompare(b.id),
  )
  const top = ordered.slice(0, 4)
  const excluded = inputs.newsClusters.length - verified.length
  const breaking = verified.filter((c) => c.isBreaking).length

  const headline: BriefingLine =
    top.length === 0
      ? {
          text: inputs.failures.some((f) => f.domain === 'news')
            ? 'No news read this cycle — news inputs were unavailable (see risk flags).'
            : `No verified story cluster in the current window${excluded > 0 ? ` (${excluded} unverified cluster${excluded === 1 ? '' : 's'} excluded)` : ''}.`,
          evidence: [],
        }
      : {
          text:
            `${verified.length} verified story cluster${verified.length === 1 ? '' : 's'} in the window, ${breaking} breaking; ` +
            `top story: "${(top[0] as NewsClusterInput).headline}" (importance ${Math.round((top[0] as NewsClusterInput).importance)})` +
            `${excluded > 0 ? ` — ${excluded} unverified cluster${excluded === 1 ? '' : 's'} excluded` : ''}.`,
          evidence: top.map((c) => ({
            source: 'news' as const,
            ref: c.id,
            value: `importance=${Math.round(c.importance)}`,
          })),
        }

  const bullets: BriefingLine[] = top.map((c) => {
    const { text: entities } = entityClause(c)
    return {
      text:
        `${c.isBreaking ? 'BREAKING · ' : ''}${c.headline} — importance ${Math.round(c.importance)}, ` +
        `${c.sourceCount} independent source${c.sourceCount === 1 ? '' : 's'}${entities === null ? '' : `; entities: ${entities}`}.`,
      evidence: [
        { source: 'news', ref: c.id, value: `importance=${Math.round(c.importance)}` },
        { source: 'news', ref: c.id, value: `sources=${c.sourceCount}` },
      ],
    }
  })

  return { id: 'moving_news', title: 'Moving News', headline, bullets }
}

// ---------------------------------------------------------------------------
// Section: risk_flags — ALWAYS renders.
// ---------------------------------------------------------------------------

function riskFlagsSection(inputs: BriefingInputs): AnalystSection {
  const flags: BriefingLine[] = []
  const nowMs = Date.parse(inputs.generatedAt)

  // Failed domains first — a section built on missing inputs must say so.
  for (const f of inputs.failures) {
    flags.push({
      text: `${f.domain} inputs degraded this cycle: ${f.message}`,
      evidence: [{ source: f.domain, ref: `failure:${f.domain}`, value: 'unavailable' }],
    })
  }

  // Data-mode honesty: any non-live prediction is named.
  const partial = inputs.marketState.filter((s) => s.dataMode === 'partial')
  if (partial.length > 0) {
    flags.push({
      text: `Partial data mode on ${partial.map((s) => s.symbol).join(', ')} — some providers fell back or were missing; quality scores already reflect the gap.`,
      evidence: partial.map((s) => ({ source: 'crypto' as const, ref: s.predictionId, value: 'dataMode=partial' })),
    })
  }
  const demo = inputs.marketState.filter((s) => s.dataMode === 'demo')
  if (demo.length > 0) {
    flags.push({
      text: `Demo data contributed to ${demo.map((s) => s.symbol).join(', ')} — those figures illustrate the pipeline and must not inform any decision.`,
      evidence: demo.map((s) => ({ source: 'crypto' as const, ref: s.predictionId, value: 'dataMode=demo' })),
    })
  }

  // Staleness, measured against the composition instant.
  const stale = inputs.marketState.filter((s) => {
    const ts = Date.parse(s.dataTimestamp)
    return Number.isFinite(ts) && Number.isFinite(nowMs) && nowMs - ts > STALE_INPUT_MS
  })
  if (stale.length > 0) {
    flags.push({
      text: `Stale inputs: ${stale
        .map((s) => `${s.symbol} (${Math.round((nowMs - Date.parse(s.dataTimestamp)) / MINUTE_MS)}m old)`)
        .join(', ')} — the oldest contributing dataset exceeds the ${STALE_INPUT_MS / MINUTE_MS}m freshness bar.`,
      evidence: stale.map((s) => ({ source: 'crypto' as const, ref: s.predictionId, value: `dataAsOf=${s.dataTimestamp}` })),
    })
  }

  // Low-conviction regime.
  const lowConf = inputs.marketState.filter((s) => s.pUp !== null && s.confidence < 0.35)
  if (lowConf.length > 0) {
    flags.push({
      text: `Low-conviction regime on ${lowConf.map((s) => s.symbol).join(', ')} — confidence below 0.35; the leans there are weak signals and sized accordingly in the language above.`,
      evidence: lowConf.map((s) => ({ source: 'crypto' as const, ref: s.predictionId, value: `confidence=${s.confidence.toFixed(2)}` })),
    })
  }

  // Model-pool disagreement.
  const split = inputs.marketState.filter((s) => s.pUp !== null && s.modelAgreement < DISAGREEMENT_THRESHOLD)
  if (split.length > 0) {
    flags.push({
      text: `Model disagreement on ${split
        .map((s) => `${s.symbol} (agreement ${s.modelAgreement.toFixed(2)})`)
        .join(', ')} — the ensemble is split below the ${DISAGREEMENT_THRESHOLD.toFixed(2)} bar; a blended probability hides a live dispute between models.`,
      evidence: split.map((s) => ({ source: 'crypto' as const, ref: s.predictionId, value: `agreement=${s.modelAgreement.toFixed(2)}` })),
    })
  }

  // Early season, at briefing level too when it affects listed fixtures.
  if (rankFixtures(inputs).slice(0, 5).some((r) => r.fixture.earlySeason)) {
    flags.push({
      text: 'Sports leans above carry an early-season caveat — under three finished rounds this season, so last season’s data dominates the fit.',
      evidence: [{ source: 'sports', ref: 'early-season', value: 'earlySeason=true' }],
    })
  }

  // The standing caveat — UNCONDITIONAL. A clean bill of health still ends
  // with this, because the absence of caveats is itself a false claim.
  flags.push({
    text: 'Standing caveat: every figure in this briefing is a probabilistic estimate computed from live inputs. Estimates can be wrong; none of the above asserts what the future holds.',
    evidence: [],
  })

  return {
    id: 'risk_flags',
    title: 'Risk Flags',
    headline: {
      text: `${flags.length} active caveat${flags.length === 1 ? '' : 's'} — read before weighing anything above.`,
      evidence: [],
    },
    bullets: flags,
  }
}

// ---------------------------------------------------------------------------
// Facts + composition
// ---------------------------------------------------------------------------

function buildFacts(inputs: BriefingInputs): BriefingFacts {
  return {
    crypto: inputs.marketState.map((s) => ({
      symbol: s.symbol,
      direction: directionOfPUp(s.pUp),
      pUp: s.pUp,
      confidence: s.confidence,
    })),
    opportunities: inputs.edgeOpportunities
      .filter((o) => o.action === 'opportunity')
      .sort((a, b) => b.opportunityScore - a.opportunityScore || a.id.localeCompare(b.id))
      .slice(0, 5)
      .map((o) => ({
        key: `${o.market.id}:${o.outcomeId}`,
        title: o.market.title,
        edgePp: o.edgePp,
      })),
    breakingClusters: inputs.newsClusters
      .filter((c) => !c.unverified && c.isBreaking)
      .map((c) => ({ id: c.id, headline: c.headline })),
  }
}

/** Compose the full briefing. Pure and deterministic: same inputs, same output. */
export function composeBriefing(inputs: BriefingInputs): AnalystBriefing {
  return {
    generatedAt: inputs.generatedAt,
    sections: [
      marketPulseSection(inputs),
      topOpportunitiesSection(inputs),
      watchNextSection(inputs),
      movingNewsSection(inputs),
      riskFlagsSection(inputs),
    ],
    facts: buildFacts(inputs),
  }
}

// ---------------------------------------------------------------------------
// whatChanged — the plan §65 diff, at briefing level. Runs on facts, not prose.
// ---------------------------------------------------------------------------

export function whatChanged(prev: AnalystBriefing | null, current: AnalystBriefing): BriefingDelta {
  if (prev === null) return { since: null, changes: [] }

  const changes: BriefingChange[] = []

  // Crypto: direction flips and confidence swings.
  const prevBySymbol = new Map(prev.facts.crypto.map((c) => [c.symbol, c]))
  for (const c of current.facts.crypto) {
    const before = prevBySymbol.get(c.symbol)
    if (before === undefined) continue
    if (before.direction !== c.direction && c.pUp !== null && before.pUp !== null) {
      changes.push({
        kind: 'direction_flip',
        text: `${c.symbol} lean flipped ${before.direction} → ${c.direction} (P(up) ${pct(before.pUp)} → ${pct(c.pUp)}).`,
        evidence: [{ source: 'crypto', ref: c.symbol, value: `P(up)=${pct(c.pUp)}` }],
      })
    }
    if (Math.abs(c.confidence - before.confidence) > CONFIDENCE_SWING_THRESHOLD) {
      const delta = c.confidence - before.confidence
      changes.push({
        kind: 'confidence_swing',
        text: `${c.symbol} confidence moved ${before.confidence.toFixed(2)} → ${c.confidence.toFixed(2)} (${delta > 0 ? '+' : '−'}${pp(Math.abs(delta), 0)}).`,
        evidence: [{ source: 'crypto', ref: c.symbol, value: `confidence=${c.confidence.toFixed(2)}` }],
      })
    }
  }

  // Opportunities: appeared / disappeared among the promoted set.
  const prevKeys = new Set(prev.facts.opportunities.map((o) => o.key))
  const currentKeys = new Set(current.facts.opportunities.map((o) => o.key))
  for (const o of current.facts.opportunities) {
    if (!prevKeys.has(o.key)) {
      changes.push({
        kind: 'new_opportunity',
        text: `New tradeable-grade divergence: ${o.title} (edge ${pp(Math.abs(o.edgePp))}).`,
        evidence: [{ source: 'edge', ref: o.key, value: `edge=${pp(o.edgePp)}` }],
      })
    }
  }
  for (const o of prev.facts.opportunities) {
    if (!currentKeys.has(o.key)) {
      changes.push({
        kind: 'removed_opportunity',
        text: `No longer promoted: ${o.title} — dropped out of the tradeable-grade set.`,
        evidence: [{ source: 'edge', ref: o.key, value: 'removed' }],
      })
    }
  }

  // News: newly breaking clusters.
  const prevBreaking = new Set(prev.facts.breakingClusters.map((c) => c.id))
  for (const c of current.facts.breakingClusters) {
    if (!prevBreaking.has(c.id)) {
      changes.push({
        kind: 'new_breaking',
        text: `New breaking cluster: ${c.headline}.`,
        evidence: [{ source: 'news', ref: c.id, value: 'breaking' }],
      })
    }
  }

  return { since: prev.generatedAt, changes }
}

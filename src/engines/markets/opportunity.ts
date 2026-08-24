/**
 * Opportunity evaluation — the centrepiece of Vixera Intelligence.
 *
 * Turns "Vixera disagrees with the market" into a ranked, risk-aware,
 * honestly-uncertain object. Three related numbers are kept deliberately
 * distinct (see VixeraOpportunity in core/markets/types.ts):
 *
 *  - edgePp        — belief divergence, measured at the MID
 *  - expectedValue — economics, measured at the ASK
 *  - confidence    — trust in our own estimate
 *
 * WHY EDGE USES THE MID BUT EV USES THE ASK: the edge is an epistemic claim —
 * "the market's belief and ours differ by X" — and the market's belief is
 * best summarised by the mid, which nets out the market-maker's toll. The
 * expected value is an economic claim — "a unit staked here returns Y" — and
 * you cannot stake at the mid; you buy at the ask. Buying the outcome at ask
 * `a` pays (1−a) on a win and −a on a loss, so EV = p(1−a) − (1−p)a = p − a.
 * Using the mid for EV would overstate returns by half the spread on every
 * single opportunity, which compounds into systematically flattering output.
 * When no ask exists there is no executable price and EV is null, not a
 * mid-based guess.
 *
 * And most importantly, §41 of the product brief: VIXERA MUST BE ALLOWED TO
 * SAY "NOTHING HERE". A market can be fairly priced, too thin, too ambiguous
 * or too uncertain to act on, and every one of those verdicts is expressed as
 * an explicit no-action reason naming its threshold — not as a low score the
 * UI is left to interpret.
 *
 * Pure: everything is derived from the parameters; time enters only via
 * `nowMs`.
 */

import { invariant } from '@/core/errors'
import type {
  MarketOrderBook,
  OpportunitySort,
  PredictionMarket,
  VixeraOpportunity,
} from '@/core/markets/types'
import { clampProbability, logit, shrinkToPrior } from '@/core/prediction/probability'

import { assessLiquidity } from './liquidity'
import { assessResolutionRisk } from './resolution-risk'

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

/**
 * =========================================================================
 * OPPORTUNITY SCORE WEIGHTING METHODOLOGY
 * =========================================================================
 *
 * The score is a weighted sum of seven bounded components (each 0..1),
 * normalised so ideal inputs reach 100, then multiplied by penalty factors.
 * Weights encode a deliberate hierarchy of what makes a divergence worth a
 * user's attention:
 *
 *  edge       0.26 — The raison d'être. Saturating via tanh(|e|/0.06): a 15pp
 *                    edge scores ≈0.99 (full marks), because beyond that size
 *                    either the model or the market is badly wrong and more
 *                    pp adds no more credibility. Tiny edges score near zero
 *                    — a 1–2pp divergence is indistinguishable from noise in
 *                    both our model and the market's price. tanh keeps the
 *                    component strictly increasing, so ranking among small
 *                    edges still works.
 *
 *  confidence 0.18 — Trust in our own probability. Second-largest weight
 *                    because a large edge we do not believe in is a warning,
 *                    not an opportunity.
 *
 *  liquidity  0.14 — Executability. Weighted above data quality/agreement
 *                    because those already feed confidence upstream, whereas
 *                    nothing else in the sum knows whether the trade exists.
 *
 *  dataQuality     0.10 ┐ Kept as separate visible terms (despite partial
 *  modelAgreement  0.10 ┘ overlap with confidence) so the breakdown shows the
 *                    user WHY a score is low, and so a confidence computed by
 *                    a future different pipeline cannot silently hide them.
 *
 *  categorySkill   0.10 — Historical Brier skill in this market's category,
 *                    shrunk toward neutral by sample size (shrinkToPrior).
 *                    A category we have never predicted in gets NO bonus and
 *                    no penalty: null skill or zero samples lands exactly on
 *                    neutral. This is the system refusing to be impressed by
 *                    its own thin history.
 *
 *  timeShape       0.06 — Small, because horizon is context rather than
 *                    signal. Shape documented at `timeShapeComponent`.
 *
 * PENALTIES ARE MULTIPLICATIVE AND APPLIED AFTER THE SUM, because they are
 * vetoes, not opinions — a high resolution risk should scale down whatever
 * the components said, not be averaged away by a great edge:
 *
 *  resolution risk  high ×0.55, medium ×0.80 — wording risk attacks the
 *                   payout itself, the one thing the other components assume.
 *  news risk        ×(1 − 0.3·newsRisk), i.e. up to ×0.70 — a market moving
 *                   on live news is a market our (older) inputs mis-describe.
 *  spread ≥ |edge|  score capped at 35 — the market-maker's toll exceeds the
 *                   entire divergence, so the edge is not executable at all.
 *                   A cap rather than a multiplier because no amount of
 *                   excellence elsewhere makes an unexecutable edge good.
 */
const WEIGHTS = {
  edge: 0.26,
  confidence: 0.18,
  dataQuality: 0.1,
  modelAgreement: 0.1,
  liquidity: 0.14,
  categorySkill: 0.1,
  timeShape: 0.06,
} as const

const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((a, b) => a + b, 0)

/** tanh scale: |edge| of 15pp → tanh(2.5) ≈ 0.987 ≈ full marks. */
const EDGE_SATURATION_PP = 0.06

/** Prior weight for category-skill shrinkage: ~25 resolved predictions in a
 *  category before its history speaks at half strength. */
const SKILL_PRIOR_WEIGHT = 25

/** No-action thresholds — named in every reason string that cites them. */
const MIN_EDGE_PP = 0.04
const MIN_CONFIDENCE = 0.45
const MIN_SCORE = 45
const HIGH_RISK_MIN_EDGE_PP = 0.1
const SPREAD_CAP_SCORE = 35

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/** Format a probability-point quantity for reason strings: 0.062 → "6.2pp". */
function fmtPp(x: number): string {
  return `${(x * 100).toFixed(1)}pp`
}

/**
 * Time-to-resolution shape, 0..1.
 *
 * Two ends of the horizon are penalised, for different reasons:
 *
 *  - VERY NEAR RESOLUTION (< ~6h): at this range the market is absorbing the
 *    final information flow. An edge here is either real and about to pay, or
 *    it is about to be destroyed by information arriving faster than our
 *    inputs refresh — and we cannot tell which from the inside. Mild ramped
 *    penalty (0.75 at 0h → 1.0 at 6h), softened to 0.95 when liquidity is
 *    excellent, because an excellent book means we could at least exit if the
 *    edge starts dying.
 *
 *  - EXTREMELY LONG HORIZONS (> ~90 days): two compounding effects. Capital
 *    efficiency — a 6pp edge locked up for a year is a poor annualised return
 *    versus the same edge next week; and drift — the world the model priced
 *    will change many times before resolution, so today's edge decays toward
 *    an unknown. Linear decay past 90 days, floored at 0.6: a long horizon
 *    dampens, it never disqualifies.
 *
 *  - UNKNOWN HORIZON: 0.85. Not knowing when you get paid is itself a mild
 *    defect, and treating it as 1.0 would reward venues for withholding the
 *    field.
 */
function timeShapeComponent(hoursToResolution: number | null, liquidityExcellent: boolean): number {
  if (hoursToResolution === null) return 0.85
  const h = Math.max(0, hoursToResolution)
  if (h < 6) {
    const ramp = 0.75 + 0.25 * (h / 6)
    return liquidityExcellent ? Math.max(ramp, 0.95) : ramp
  }
  const days = h / 24
  if (days <= 90) return 1
  return Math.max(0.6, 1 - (days - 90) / 365)
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function evaluateOpportunity(params: {
  market: PredictionMarket
  outcomeId: string
  /** Vixera's modelled probability of this outcome, 0..1. */
  vixeraProbability: number
  /** 0..1 — trust in the modelled probability (see core/prediction/confidence). */
  confidence: number
  /** 0..100 from the data-quality engine. */
  dataQuality: number
  /** 0..1 — ensemble agreement. */
  modelAgreement: number
  /** 0..1 — how heavily live news flow is currently moving this market's inputs. */
  newsRisk: number
  /** Historical Brier skill in this market's category, and how much history backs it. */
  historicalCategoryAccuracy: { brierSkill: number | null; sampleSize: number }
  book?: MarketOrderBook | null
  nowMs: number
  predictionId: string | null
  dataMode: 'live' | 'partial' | 'demo'
}): VixeraOpportunity {
  const { market } = params
  const outcome = market.outcomes.find((o) => o.id === params.outcomeId)
  invariant(outcome !== undefined, `outcome '${params.outcomeId}' not found in market '${market.id}'`)

  // Sanitise every scalar input at the boundary. Adversarial or broken inputs
  // (NaN confidence, Infinity volume) must degrade the score, never crash the
  // engine or escape into the output object.
  const vixeraProbability = clampProbability(params.vixeraProbability, 0)
  const marketProbability = clampProbability(outcome.marketProbability, 0)
  const confidence = clamp01(params.confidence)
  const dataQuality = Math.min(100, Math.max(0, Number.isFinite(params.dataQuality) ? params.dataQuality : 0))
  const modelAgreement = clamp01(params.modelAgreement)
  const newsRisk = clamp01(params.newsRisk)
  const nowMs = Number.isFinite(params.nowMs) ? params.nowMs : 0

  // --- Edge (at the mid) and EV (at the ask) — see the header for why they
  // --- deliberately use different prices.
  const edgePp = vixeraProbability - marketProbability
  const ask = outcome.ask !== null && Number.isFinite(outcome.ask) ? clampProbability(outcome.ask, 0) : null
  const expectedValue = ask !== null ? vixeraProbability - ask : null

  // --- Sub-assessments (each pure, each independently tested).
  const liquidity = assessLiquidity({
    spread: market.spread,
    volume: market.volume,
    volume24h: market.volume24h,
    liquidity: market.liquidity,
    book: params.book,
  })
  const resolutionRisk = assessResolutionRisk(market.resolutionRules, market.closeTime, market.resolutionTime)

  // --- Horizon. Resolution time preferred; close time is the venue's floor
  // --- on it when resolution is unreported. Past timestamps clamp to 0.
  const horizonIso = market.resolutionTime ?? market.closeTime
  const horizonMs = horizonIso !== null ? Date.parse(horizonIso) : NaN
  const hoursToResolution = Number.isFinite(horizonMs) ? Math.max(0, (horizonMs - nowMs) / 3_600_000) : null

  // --- Category skill, shrunk toward neutral (0 = no skill either way).
  // --- null skill contributes zero observations, so it lands exactly on the
  // --- prior: a category with no history earns NO bonus and no penalty.
  const { brierSkill, sampleSize } = params.historicalCategoryAccuracy
  const skillObserved = brierSkill !== null && Number.isFinite(brierSkill) ? brierSkill : 0
  const skillSamples = brierSkill !== null && Number.isFinite(sampleSize) ? Math.max(0, sampleSize) : 0
  const shrunkSkill = shrinkToPrior(skillObserved, skillSamples, 0, SKILL_PRIOR_WEIGHT)

  // --- Components, all 0..1. See WEIGHTS block for the methodology.
  const components = {
    edge: Math.tanh(Math.abs(edgePp) / EDGE_SATURATION_PP),
    confidence,
    dataQuality: dataQuality / 100,
    modelAgreement,
    liquidity: liquidity.score / 100,
    categorySkill: clamp01(0.5 + 0.5 * Math.max(-1, Math.min(1, shrunkSkill))),
    timeShape: timeShapeComponent(hoursToResolution, liquidity.grade === 'excellent'),
  }

  let weighted = 0
  for (const key of Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]) {
    weighted += WEIGHTS[key] * components[key]
  }
  const base = weighted / TOTAL_WEIGHT // 0..1, ideal inputs → 1

  // --- Multiplicative penalties (vetoes, not opinions — see WEIGHTS block).
  const resolutionPenalty =
    resolutionRisk.level === 'high' ? 0.55 : resolutionRisk.level === 'medium' ? 0.8 : 1
  const newsPenalty = 1 - 0.3 * newsRisk

  let opportunityScore = 100 * base * resolutionPenalty * newsPenalty

  // --- The spread-eats-the-edge cap. The executable spread: the venue's
  // --- reported spread, else derived from this outcome's own quotes.
  const derivedSpread =
    outcome.bid !== null && outcome.ask !== null && Number.isFinite(outcome.bid) && Number.isFinite(outcome.ask)
      ? Math.max(0, outcome.ask - outcome.bid)
      : null
  const marketSpread =
    market.spread !== null && Number.isFinite(market.spread) ? Math.max(0, market.spread) : derivedSpread
  const spreadEatsEdge = marketSpread !== null && marketSpread >= Math.abs(edgePp)
  if (spreadEatsEdge) {
    opportunityScore = Math.min(opportunityScore, SPREAD_CAP_SCORE)
  }
  opportunityScore = Math.min(100, Math.max(0, opportunityScore))

  // --- NO-ACTION LOGIC (§41). Every verdict names its threshold so the user
  // --- (and the test suite) can see exactly which gate closed.
  const noActionReasons: string[] = []
  if (params.dataMode === 'demo') {
    noActionReasons.push(
      'Demo data mode: demo data illustrates the pipeline but can never generate a real opportunity',
    )
  }
  if (Math.abs(edgePp) < MIN_EDGE_PP) {
    noActionReasons.push(
      `Edge ${fmtPp(edgePp)} is below the ${fmtPp(MIN_EDGE_PP)} minimum — indistinguishable from model and market noise`,
    )
  }
  if (confidence < MIN_CONFIDENCE) {
    noActionReasons.push(
      `Confidence ${confidence.toFixed(2)} is below the ${MIN_CONFIDENCE} threshold — the estimate itself is not trustworthy enough to act on`,
    )
  }
  if (liquidity.grade === 'poor' || liquidity.grade === 'illiquid') {
    noActionReasons.push(
      `Liquidity grade '${liquidity.grade}' is below the minimum tradeable grade ('fair') — the position could not be entered or exited at meaningful size`,
    )
  }
  if (spreadEatsEdge) {
    noActionReasons.push(
      `Spread ${fmtPp(marketSpread ?? 0)} ≥ edge ${fmtPp(Math.abs(edgePp))} — the market-maker's toll consumes the entire edge, so it is not executable`,
    )
  }
  if (resolutionRisk.level === 'high' && Math.abs(edgePp) < HIGH_RISK_MIN_EDGE_PP) {
    noActionReasons.push(
      `Resolution risk is high and edge ${fmtPp(Math.abs(edgePp))} is below the ${fmtPp(HIGH_RISK_MIN_EDGE_PP)} required to accept ambiguous resolution wording`,
    )
  }
  if (opportunityScore < MIN_SCORE) {
    noActionReasons.push(
      `Opportunity score ${opportunityScore.toFixed(1)} is below the ${MIN_SCORE} action threshold`,
    )
  }

  return {
    // Deterministic id — same market, outcome and evaluation instant always
    // produce the same opportunity (pure function, no randomness allowed).
    id: `opp:${market.id}:${params.outcomeId}:${nowMs}`,
    market,
    outcomeId: outcome.id,
    outcomeName: outcome.name,
    vixeraProbability,
    marketProbability,
    edgePp,
    expectedValue,
    confidence,
    dataQuality,
    modelAgreement,
    liquidity,
    resolutionRisk,
    newsRisk,
    hoursToResolution,
    opportunityScore,
    action: noActionReasons.length > 0 ? 'no_action' : 'opportunity',
    noActionReasons,
    scoreBreakdown: {
      ...components,
      resolutionPenalty,
      newsPenalty,
      spreadCapApplied: spreadEatsEdge ? 1 : 0,
    },
    predictionId: params.predictionId,
    generatedAt: new Date(nowMs).toISOString(),
    dataMode: params.dataMode,
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 }

/**
 * Sort a list of opportunities. Non-mutating; every sort has a deterministic
 * tiebreak chain ending in id, so identical inputs always rank identically.
 *
 * Note on 'probability_change': the honest version of this sort needs a
 * probability-history snapshot per market, which the opportunity object does
 * not yet carry. Until it does, we rank by the LOG-ODDS distance between
 * Vixera and the market — how far the market's belief would have to MOVE to
 * meet ours — which differs from raw edge at extreme probabilities (0.95 vs
 * 0.99 is a small edge but a large move) and is the closest available proxy.
 */
export function rankOpportunities(
  list: readonly VixeraOpportunity[],
  sort: OpportunitySort,
): VixeraOpportunity[] {
  const byScoreDesc = (a: VixeraOpportunity, b: VixeraOpportunity): number =>
    b.opportunityScore - a.opportunityScore

  const chain =
    (...cmps: ((a: VixeraOpportunity, b: VixeraOpportunity) => number)[]) =>
    (a: VixeraOpportunity, b: VixeraOpportunity): number => {
      for (const cmp of cmps) {
        const d = cmp(a, b)
        if (d !== 0) return d
      }
      return a.id.localeCompare(b.id)
    }

  const comparators: Record<OpportunitySort, (a: VixeraOpportunity, b: VixeraOpportunity) => number> = {
    // Headline ranking.
    score: chain(byScoreDesc),

    // Largest divergence first — magnitude, because sign is direction, not size.
    edge: chain((a, b) => Math.abs(b.edgePp) - Math.abs(a.edgePp), byScoreDesc),

    confidence: chain((a, b) => b.confidence - a.confidence, byScoreDesc),

    liquidity: chain((a, b) => b.liquidity.score - a.liquidity.score, byScoreDesc),

    // Least risky first: resolution risk level, then news risk, then score.
    risk: chain(
      (a, b) => (RISK_RANK[a.resolutionRisk.level] ?? 1) - (RISK_RANK[b.resolutionRisk.level] ?? 1),
      (a, b) => a.newsRisk - b.newsRisk,
      byScoreDesc,
    ),

    // Soonest resolution first; unknown horizons sort last — "we don't know
    // when" must never masquerade as "imminent".
    ending_soon: chain((a, b) => {
      if (a.hoursToResolution === null && b.hoursToResolution === null) return 0
      if (a.hoursToResolution === null) return 1
      if (b.hoursToResolution === null) return -1
      return a.hoursToResolution - b.hoursToResolution
    }, byScoreDesc),

    // Most recently generated first (epoch compare — ISO strings from
    // different clock skews should not be compared lexicographically).
    newest: chain((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt), byScoreDesc),

    // See function doc: log-odds distance proxy until history snapshots land.
    probability_change: chain(
      (a, b) =>
        Math.abs(logit(b.vixeraProbability) - logit(b.marketProbability)) -
        Math.abs(logit(a.vixeraProbability) - logit(a.marketProbability)),
      byScoreDesc,
    ),
  }

  return [...list].sort(comparators[sort])
}

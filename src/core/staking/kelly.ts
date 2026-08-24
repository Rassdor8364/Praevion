/**
 * Kelly staking mathematics.
 *
 * The Kelly criterion gives the log-wealth-optimal fraction of a bankroll to
 * risk on a positive-EV proposition: f* = (d·p − 1)/(d − 1) for a bet paying
 * decimal odds d with true win probability p. It is presented here strictly
 * as ANALYTICAL sizing mathematics — a property of a probability estimate
 * and a price, like expected value — never as advice to wager. The UI pairs
 * every rendered figure with the product disclaimer.
 *
 * Why fractional Kelly is the default and full Kelly is not even exposed as
 * a preset: Kelly is optimal only if p is exactly right, and our p carries
 * model error by construction (that is what the confidence system measures).
 * Overestimating the edge with full Kelly OVER-bets — the growth curve is
 * asymmetric, and betting 2× the true Kelly fraction has zero growth and
 * enormous variance. Quarter Kelly keeps ~44% of the theoretical growth rate
 * at a small fraction of the variance and is far more robust to a p that is
 * a few points optimistic. On top of the multiplier there is a hard absolute
 * cap, because no single analytical edge deserves a large slice of a
 * bankroll no matter what the arithmetic says.
 *
 * Pure module: no clock, no I/O, no randomness.
 */

import { invariant } from '../errors'

export interface StakingInputs {
  /** Model probability of the outcome, 0..1 exclusive. */
  readonly probability: number
  /** Executable decimal odds (> 1), e.g. 2.22, or a prediction-market ask
   *  converted via 1/ask. */
  readonly decimalOdds: number
  /** Kelly multiplier, default quarter Kelly. */
  readonly kellyMultiplier?: number
  /** Hard ceiling on the suggested fraction, default 2% of bankroll. */
  readonly capFraction?: number
}

export interface StakingAssessment {
  /** Full Kelly fraction, 0 when the price offers no positive edge. */
  readonly kellyFraction: number
  /** Fractional Kelly after the multiplier AND the absolute cap. */
  readonly adjustedFraction: number
  /** Expected profit per unit staked at these odds: d·p − 1. */
  readonly expectedValuePerUnit: number
  /** Break-even probability implied by the odds: 1/d. */
  readonly breakevenProbability: number
  /** True when the model probability clears break-even. */
  readonly hasPositiveExpectation: boolean
}

export const DEFAULT_KELLY_MULTIPLIER = 0.25
export const DEFAULT_CAP_FRACTION = 0.02

/**
 * Full Kelly fraction for a decimal-odds proposition. Zero (never negative)
 * when the odds offer no positive expectation — Kelly's negative region means
 * "the opposite side or nothing", and this function refuses to express a
 * position as a negative stake.
 */
export function kellyFraction(probability: number, decimalOdds: number): number {
  invariant(
    probability > 0 && probability < 1,
    `kellyFraction requires probability in (0,1), got ${probability}`,
  )
  invariant(
    Number.isFinite(decimalOdds) && decimalOdds > 1,
    `kellyFraction requires decimal odds > 1, got ${decimalOdds}`,
  )
  const f = (decimalOdds * probability - 1) / (decimalOdds - 1)
  return Math.max(0, f)
}

/** The full assessment the UI renders: Kelly, fractional Kelly, EV. */
export function assessStaking(inputs: StakingInputs): StakingAssessment {
  const multiplier = inputs.kellyMultiplier ?? DEFAULT_KELLY_MULTIPLIER
  const cap = inputs.capFraction ?? DEFAULT_CAP_FRACTION
  invariant(multiplier > 0 && multiplier <= 1, `kelly multiplier must be in (0,1], got ${multiplier}`)
  invariant(cap > 0 && cap <= 1, `cap fraction must be in (0,1], got ${cap}`)

  const kelly = kellyFraction(inputs.probability, inputs.decimalOdds)
  const ev = inputs.decimalOdds * inputs.probability - 1

  return {
    kellyFraction: kelly,
    adjustedFraction: Math.min(cap, kelly * multiplier),
    expectedValuePerUnit: ev,
    breakevenProbability: 1 / inputs.decimalOdds,
    hasPositiveExpectation: ev > 0,
  }
}

/**
 * Convenience for prediction-market prices quoted as probabilities (an ask of
 * 0.43 pays out 1): the equivalent decimal odds are 1/ask.
 */
export function assessStakingAtAsk(
  probability: number,
  ask: number,
  options?: Pick<StakingInputs, 'kellyMultiplier' | 'capFraction'>,
): StakingAssessment {
  invariant(ask > 0 && ask < 1, `ask must be in (0,1), got ${ask}`)
  return assessStaking({ probability, decimalOdds: 1 / ask, ...options })
}

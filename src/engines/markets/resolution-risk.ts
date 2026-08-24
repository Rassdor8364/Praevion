/**
 * Resolution risk: how likely is this market to resolve in a way that
 * surprises someone who was RIGHT about the underlying event?
 *
 * Prediction markets do not pay you for being right about the world; they pay
 * you for being right about what the RESOLUTION SOURCE will say, under the
 * exact wording of the rules. The gap between those two things — ambiguous
 * wording, unnamed sources, resolver discretion, long information vacuums —
 * is a risk that no amount of forecasting skill removes, so it is assessed
 * separately and applied to the opportunity score as a penalty rather than
 * being folded into the probability itself.
 *
 * THIS IS A HEURISTIC PRE-SCREEN. It reads for known red-flag phrasings and
 * structural problems; it does not understand the rules. LLM-based rule
 * parsing arrives in a later phase and will feed this same `ResolutionRisk`
 * interface, so everything downstream (scoring, UI, alerts) is already
 * written against the final contract. Until then the heuristics are tuned to
 * be cheap, deterministic, and biased toward flagging — a false "medium" costs
 * a little score; a false "low" costs a user real money.
 *
 * Pure: strings in, an assessment out.
 */

import type { ResolutionRisk, ResolutionRiskLevel } from '@/core/markets/types'

// ---------------------------------------------------------------------------
// Red-flag vocabularies
// ---------------------------------------------------------------------------

/**
 * Phrases that hand the resolver discretion or leave the criterion open.
 * Each is an independent flag: a rule that both "may be determined" and is
 * decided "in the sole discretion" of someone is worse than one with a single
 * escape hatch.
 */
const AMBIGUITY_MARKERS: readonly { phrase: string; label: string }[] = [
  { phrase: 'in the sole discretion', label: 'resolver discretion ("in the sole discretion")' },
  { phrase: 'may be determined', label: 'open-ended determination ("may be determined")' },
  { phrase: 'or similar', label: 'unbounded criterion ("or similar")' },
  { phrase: 'consensus of', label: 'consensus-based resolution ("consensus of") — whose consensus, measured how?' },
]

/**
 * Subjective qualifiers. "Significant", "major" and "widely reported" are the
 * classic disputed-resolution vocabulary: every side of a dispute can cite a
 * dictionary in its favour. Matched on word boundaries so "majority" does not
 * trip "major".
 */
const SUBJECTIVE_PATTERNS: readonly { re: RegExp; label: string }[] = [
  { re: /\bsignificant\b/i, label: '"significant"' },
  { re: /\bmajor\b/i, label: '"major"' },
  { re: /\bwidely reported\b/i, label: '"widely reported"' },
]

/**
 * Evidence that a concrete data source is actually named: a URL, a domain, or
 * a multi-word proper noun ("Bureau of Labor Statistics", "Associated Press").
 * Crude, but the failure mode of the crudeness is a false flag on an unusual
 * rule text — which is the direction we want to fail in.
 */
function namesASource(rules: string): boolean {
  if (/https?:\/\//i.test(rules)) return true
  if (/\.(com|org|gov|net|edu)\b/i.test(rules)) return true
  // Two consecutive capitalised words mid-text is our proper-noun heuristic.
  if (/\b[A-Z][a-z]+\s+(?:of\s+|for\s+)?[A-Z][a-z]+/.test(rules)) return true
  return false
}

/** Resolution more than this long after close = information vacuum flag. */
const TIMING_GAP_DAYS = 7

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

export function assessResolutionRisk(
  rules: string | null,
  closeTime: string | null,
  resolutionTime: string | null,
): ResolutionRisk {
  const reasons: string[] = []
  let points = 0

  if (rules === null || rules.trim().length === 0) {
    // You cannot assess what you cannot read. Absent rules are not "no red
    // flags found" — they are ALL flags unfalsifiable at once, which floors
    // the level at medium (2 points) regardless of anything else.
    reasons.push('Resolution rules are absent — cannot assess what cannot be read (medium floor)')
    points += 2
  } else {
    const lower = rules.toLowerCase()

    for (const marker of AMBIGUITY_MARKERS) {
      if (lower.includes(marker.phrase)) {
        reasons.push(`Ambiguity marker: ${marker.label}`)
        points += 1
      }
    }

    // "Official source" that never says WHICH official source is the classic
    // dispute template: the two sides simply pick different officials.
    const sourced = namesASource(rules)
    if (lower.includes('official source') && !sourced) {
      reasons.push('Refers to an "official source" without naming one')
      points += 1
    }

    if (!sourced) {
      reasons.push('No named data source — resolution depends on an unspecified authority')
      points += 1
    }

    const subjective = SUBJECTIVE_PATTERNS.filter((p) => p.re.test(rules))
    if (subjective.length > 0) {
      reasons.push(`Subjective resolution language: ${subjective.map((s) => s.label).join(', ')}`)
      points += subjective.length
    }
  }

  // Timing gap: a market that closes long before it resolves traps capital in
  // an information vacuum — the outcome may be publicly known for days while
  // the position can be neither settled nor exited. Only assessable when the
  // venue reports both timestamps and they parse.
  const closeMs = closeTime !== null ? Date.parse(closeTime) : NaN
  const resolveMs = resolutionTime !== null ? Date.parse(resolutionTime) : NaN
  if (Number.isFinite(closeMs) && Number.isFinite(resolveMs)) {
    const gapDays = (resolveMs - closeMs) / 86_400_000
    if (gapDays > TIMING_GAP_DAYS) {
      reasons.push(
        `Resolution scheduled ${Math.round(gapDays)} days after close (> ${TIMING_GAP_DAYS}) — capital sits in an information vacuum`,
      )
      points += 1
    }
  }

  // 0 flags = low; a flag or two = medium; three or more = the wording itself
  // is a material part of the trade and the score penalty should bite.
  let level: ResolutionRiskLevel
  if (points === 0) level = 'low'
  else if (points <= 2) level = 'medium'
  else level = 'high'

  return { level, reasons }
}

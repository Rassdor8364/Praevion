/**
 * football.learned tests — feature building, TEMPORAL INTEGRITY (the leakage
 * tests §4 demands), abstention rules, and end-to-end learning on a synthetic
 * league with a known ordering.
 */

import { describe, expect, it } from 'vitest'

import type { FinishedGame } from '@/engines/sports/elo'
import {
  buildFixtureFeatures,
  buildLearnedTrainingSet,
  LEARNED_FEATURE_COUNT,
  MIN_TRAINING_SAMPLES,
  runLearnedModel,
} from '@/engines/sports/learned'

const DAY = 24 * 3600 * 1000
const T0 = Date.UTC(2025, 7, 1)

function game(
  round: number,
  home: string,
  away: string,
  homeScore: number,
  awayScore: number,
): FinishedGame {
  return { homeTeamId: home, awayTeamId: away, homeScore, awayScore, kickoff: T0 + round * 3 * DAY }
}

/**
 * Synthetic league with a strict pecking order A > B > C > D: A beats
 * everyone 2-0, B beats C and D 2-1, C beats D 1-0, regardless of venue.
 * `rounds` full double round-robins give 12 games per round-pair.
 */
function syntheticLeague(rounds: number): FinishedGame[] {
  const teams = ['A', 'B', 'C', 'D']
  const beats = (x: string, y: string): boolean => teams.indexOf(x) < teams.indexOf(y)
  const games: FinishedGame[] = []
  let round = 0
  for (let r = 0; r < rounds; r++) {
    for (const home of teams) {
      for (const away of teams) {
        if (home === away) continue
        const [hs, as] = beats(home, away) ? [2, 0] : [0, 2]
        games.push(game(round, home, away, hs, as))
        round += 1
      }
    }
  }
  return games
}

describe('buildLearnedTrainingSet', () => {
  it('skips cold-start games and labels the rest correctly', () => {
    const games = syntheticLeague(3) // 36 games
    const asOf = Number.MAX_SAFE_INTEGER
    const { samples, skippedColdStart } = buildLearnedTrainingSet(games, asOf, 5)
    expect(samples.length + skippedColdStart).toBe(36)
    expect(skippedColdStart).toBeGreaterThan(0)
    for (const s of samples) {
      expect(s.features).toHaveLength(LEARNED_FEATURE_COUNT)
      expect([0, 1, 2]).toContain(s.label)
      for (const f of s.features) expect(Number.isFinite(f)).toBe(true)
    }
  })

  it('LEAKAGE: games after asOf never influence the training set', () => {
    const games = syntheticLeague(4)
    const cutoff = games[30]?.kickoff ?? 0
    const base = buildLearnedTrainingSet(games, cutoff, 3)

    // Append future games — including an absurd result that would move every
    // accumulator if it leaked in.
    const withFuture = [
      ...games,
      { homeTeamId: 'D', awayTeamId: 'A', homeScore: 9, awayScore: 0, kickoff: cutoff + DAY },
      { homeTeamId: 'D', awayTeamId: 'B', homeScore: 9, awayScore: 0, kickoff: cutoff + 2 * DAY },
    ]
    const after = buildLearnedTrainingSet(withFuture, cutoff, 3)
    expect(after.samples).toEqual(base.samples)
  })

  it("LEAKAGE: a game's own result never reaches its own features", () => {
    const games = syntheticLeague(4)
    const idx = 40
    const target = games[idx]
    expect(target).toBeDefined()
    if (target === undefined) return

    // Flip the target game's score to an extreme value. Its own sample's
    // FEATURES must be identical (they are read pre-update); only its label
    // may change.
    const flipped = games.map((g, i) =>
      i === idx ? { ...g, homeScore: 9, awayScore: 0 } : g,
    )
    const asOf = target.kickoff // truncate AT the target so it is the last sample
    const base = buildLearnedTrainingSet(games, asOf, 3)
    const after = buildLearnedTrainingSet(flipped, asOf, 3)

    const last = base.samples[base.samples.length - 1]
    const lastFlipped = after.samples[after.samples.length - 1]
    expect(last?.timestamp).toBe(target.kickoff)
    expect(lastFlipped?.features).toEqual(last?.features)
  })
})

describe('buildFixtureFeatures', () => {
  it('returns null when a side lacks history', () => {
    const games = syntheticLeague(2)
    expect(buildFixtureFeatures(games, 'A', 'NEWTEAM', Number.MAX_SAFE_INTEGER, 5)).toBeNull()
  })

  it('is unaffected by games after asOf', () => {
    const games = syntheticLeague(4)
    const cutoff = games[35]?.kickoff ?? 0
    const base = buildFixtureFeatures(games, 'A', 'D', cutoff, 3)
    const withFuture = buildFixtureFeatures(
      [...games, { homeTeamId: 'A', awayTeamId: 'D', homeScore: 0, awayScore: 9, kickoff: cutoff + DAY }],
      'A',
      'D',
      cutoff,
      3,
    )
    expect(withFuture).toEqual(base)
  })
})

describe('runLearnedModel', () => {
  it('abstains below the minimum training-sample threshold', () => {
    const games = syntheticLeague(3) // 36 games < MIN_TRAINING_SAMPLES after cold start
    const r = runLearnedModel({
      homeTeamId: 'A',
      awayTeamId: 'D',
      leagueGames: games,
      asOf: Number.MAX_SAFE_INTEGER,
    })
    expect(r.output.abstained).toBe(true)
    expect(r.output.abstainReason).toContain(`${MIN_TRAINING_SAMPLES}`)
    expect(r.model).toBeNull()
  })

  it('learns the pecking order from history alone', () => {
    const games = syntheticLeague(14) // 168 games → ample samples
    const asOf = Number.MAX_SAFE_INTEGER

    const strongHome = runLearnedModel({
      homeTeamId: 'A',
      awayTeamId: 'D',
      leagueGames: games,
      asOf,
    })
    expect(strongHome.output.abstained).toBe(false)
    const pHomeWin = strongHome.output.outcomes.find((o) => o.key === 'home')?.probability ?? 0
    expect(pHomeWin).toBeGreaterThan(0.5)

    // The mirror fixture: the weakest side at home against the strongest.
    const weakHome = runLearnedModel({
      homeTeamId: 'D',
      awayTeamId: 'A',
      leagueGames: games,
      asOf,
    })
    const pAwayWin = weakHome.output.outcomes.find((o) => o.key === 'away')?.probability ?? 0
    expect(pAwayWin).toBeGreaterThan(0.5)

    // Learned probabilities are a distribution.
    const sum = strongHome.output.outcomes.reduce((a, o) => a + o.probability, 0)
    expect(sum).toBeCloseTo(1, 9)
  })

  it('is deterministic end to end', () => {
    const games = syntheticLeague(14)
    const run = () =>
      runLearnedModel({ homeTeamId: 'B', awayTeamId: 'C', leagueGames: games, asOf: Number.MAX_SAFE_INTEGER })
    const a = run()
    const b = run()
    expect(a.output.outcomes).toEqual(b.output.outcomes)
    expect(a.model?.weights).toEqual(b.model?.weights)
  })

  it('surfaces real learned feature contributions, capped at three', () => {
    const games = syntheticLeague(14)
    const r = runLearnedModel({
      homeTeamId: 'A',
      awayTeamId: 'D',
      leagueGames: games,
      asOf: Number.MAX_SAFE_INTEGER,
    })
    expect(r.output.featureContributions.length).toBeLessThanOrEqual(3)
    for (const f of r.output.featureContributions) {
      expect(f.detail).toMatch(/coefficient gap/)
    }
  })
})

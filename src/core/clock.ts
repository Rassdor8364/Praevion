/**
 * Injectable clock.
 *
 * Engines are pure and must be replayable at an arbitrary historical instant —
 * that is the entire basis of point-in-time backtesting. An engine that calls
 * `Date.now()` directly cannot be replayed, and a backtest built on one is
 * measuring hindsight rather than skill. Every time-dependent computation
 * therefore takes a Clock.
 */

export interface Clock {
  now(): number
}

export const systemClock: Clock = {
  now: () => Date.now(),
}

/** Clock frozen at a fixed instant — used by backtests and by every unit test. */
export function fixedClock(epochMs: number): Clock {
  return { now: () => epochMs }
}

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

export function ageMs(timestampMs: number, clock: Clock): number {
  return Math.max(0, clock.now() - timestampMs)
}

export function isoNow(clock: Clock): string {
  return new Date(clock.now()).toISOString()
}

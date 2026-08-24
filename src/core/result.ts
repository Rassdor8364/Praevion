/**
 * Result<T, E> — explicit success/failure values.
 *
 * Provider and repository boundaries return Result rather than throwing. A data
 * source being unavailable is an expected, routine condition that the
 * orchestrator must reason about (it degrades data quality and may force
 * `dataMode: 'partial'`), not an exceptional one that should unwind the stack
 * into a 500. Throwing is reserved for programmer error.
 */

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok
}

export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok
}

export function mapResult<T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r
}

/** Unwrap with a fallback. Never throws. */
export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback
}

/** Collect the successful values, discarding failures. */
export function successes<T, E>(rs: readonly Result<T, E>[]): T[] {
  const out: T[] = []
  for (const r of rs) if (r.ok) out.push(r.value)
  return out
}

/** Collect the failures. */
export function failures<T, E>(rs: readonly Result<T, E>[]): E[] {
  const out: E[] = []
  for (const r of rs) if (!r.ok) out.push(r.error)
  return out
}

/** Wrap a promise that may reject into a Result. */
export async function tryAsync<T>(
  fn: () => Promise<T>,
  onError: (e: unknown) => Error = (e) => (e instanceof Error ? e : new Error(String(e))),
): Promise<Result<T, Error>> {
  try {
    return ok(await fn())
  } catch (e) {
    return err(onError(e))
  }
}

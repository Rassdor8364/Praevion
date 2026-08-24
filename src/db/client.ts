/**
 * Supabase clients.
 *
 * Three clients, three trust levels:
 *
 *   createServerClient()  — RSC / route handlers. Anon key + the user's cookies.
 *                           RLS applies, so it sees exactly what the user may.
 *   createServiceClient() — ingestion, cron, settlement. Service-role key,
 *                           BYPASSRLS. Server-only, enforced at runtime.
 *   createBrowserClient() — client components. Anon key, no cookies handling of
 *                           our own (the library manages them).
 *
 * ALL THREE RETURN `null` WHEN SUPABASE IS NOT CONFIGURED.
 *
 * That is deliberate. This application has to build, boot and render before a
 * Supabase project exists — and it has to keep rendering if the environment is
 * misconfigured in production. A missing env var is not a reason to crash a
 * process; it is a reason to render "Data unavailable — database not
 * configured", which is a truthful statement about the system's state and
 * therefore exactly the kind of message this product is supposed to produce.
 * Callers check the null (or call `isSupabaseConfigured()` first) and render
 * the unconfigured state.
 */

import { createBrowserClient as createSsrBrowserClient } from '@supabase/ssr'
import { createServerClient as createSsrServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from './types'

export type VixeraSupabaseClient = SupabaseClient<Database, 'public'>

/** Message rendered wherever the database is required but absent. */
export const DB_UNAVAILABLE_MESSAGE = 'Data unavailable — database not configured'

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function readEnv(name: string): string | null {
  // `process` is undefined in some edge runtimes; guard rather than assume.
  if (typeof process === 'undefined' || !process.env) return null
  const value = process.env[name]
  return value !== undefined && value.length > 0 ? value : null
}

/**
 * The public pair. Both are safe to expose to the browser: the anon key grants
 * nothing on its own, because every table is behind RLS (0007).
 */
export function getSupabaseUrl(): string | null {
  return readEnv('NEXT_PUBLIC_SUPABASE_URL')
}

export function getSupabaseAnonKey(): string | null {
  return readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')
}

/**
 * True when the anon pair is present, i.e. when normal user-scoped reads are
 * possible. Screens call this to decide between rendering data and rendering
 * the unconfigured state.
 */
export function isSupabaseConfigured(): boolean {
  return getSupabaseUrl() !== null && getSupabaseAnonKey() !== null
}

/**
 * True when the service-role key is also present, i.e. when ingestion jobs can
 * run. Separate from `isSupabaseConfigured` because a correctly configured
 * browser deployment intentionally has no service key.
 */
export function isServiceRoleConfigured(): boolean {
  return getSupabaseUrl() !== null && readEnv('SUPABASE_SERVICE_ROLE_KEY') !== null
}

// ---------------------------------------------------------------------------
// Server client (RSC, route handlers, server actions)
// ---------------------------------------------------------------------------

/**
 * Per-request client bound to the caller's cookies. Never cache or share the
 * returned client across requests — it carries one user's session.
 *
 * `next/headers` is imported dynamically so that this module can also be
 * imported from a client component without dragging a server-only module into
 * the browser bundle.
 */
export async function createServerClient(): Promise<VixeraSupabaseClient | null> {
  const url = getSupabaseUrl()
  const anonKey = getSupabaseAnonKey()
  if (url === null || anonKey === null) return null

  // Next 15: cookies() is async.
  const { cookies } = await import('next/headers')
  const cookieStore = await cookies()

  return createSsrServerClient<Database, 'public'>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Writing cookies from a Server Component is not allowed. This is the
          // documented, expected case: middleware refreshes the session, so
          // swallowing it here is correct rather than lazy.
        }
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Service client (ingestion, cron, settlement)
// ---------------------------------------------------------------------------

/**
 * Service-role client. BYPASSES RLS ENTIRELY.
 *
 * This is the only way anything writes market/reference data, because those
 * tables have no write policy at all (see 0007_rls).
 *
 * `import 'server-only'` — this module is not marked with the package because
 * `client.ts` also exports the browser client, so the guarantee is enforced at
 * runtime instead: the function throws the moment it is reached in a browser.
 * If you split this file, add the real `import 'server-only'` to the server
 * half.
 */
export function createServiceClient(): VixeraSupabaseClient | null {
  // A service-role key in a browser bundle is a total compromise: it reads and
  // writes every row of every tenant. Fail loudly and immediately rather than
  // returning a client that would work.
  if (typeof window !== 'undefined') {
    throw new Error(
      'createServiceClient() was called in a browser context. The service-role key bypasses RLS and must never reach the client bundle. Import this only from server code (route handlers, server actions, cron jobs).',
    )
  }

  const url = getSupabaseUrl()
  const serviceKey = readEnv('SUPABASE_SERVICE_ROLE_KEY')
  if (url === null || serviceKey === null) return null

  // Uses the SSR server client with a no-op cookie store: the service role has
  // no user session to persist, and giving it one would be a way for a request
  // to accidentally influence a privileged client.
  return createSsrServerClient<Database, 'public'>(url, serviceKey, {
    cookies: {
      getAll() {
        return []
      },
      setAll() {
        /* the service client is stateless by design */
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

// ---------------------------------------------------------------------------
// Browser client (client components)
// ---------------------------------------------------------------------------

/**
 * Client-component client. Reads only `NEXT_PUBLIC_*` env vars, so nothing
 * secret can reach it even by mistake.
 *
 * Singleton per tab: `@supabase/ssr` handles that internally, but we also cache
 * it here so repeated calls in a render tree do not build new instances.
 */
let browserClient: VixeraSupabaseClient | null = null

export function createBrowserClient(): VixeraSupabaseClient | null {
  if (browserClient !== null) return browserClient

  const url = getSupabaseUrl()
  const anonKey = getSupabaseAnonKey()
  if (url === null || anonKey === null) return null

  browserClient = createSsrBrowserClient<Database, 'public'>(url, anonKey)
  return browserClient
}

/** Test seam: drop the cached browser client. */
export function resetBrowserClient(): void {
  browserClient = null
}

#!/usr/bin/env tsx
/**
 * Migration runner.
 *
 *   npx tsx scripts/migrate.ts up          apply every pending migration
 *   npx tsx scripts/migrate.ts down 1      roll back the last N migrations
 *   npx tsx scripts/migrate.ts status      show what is applied and what is not
 *
 * Design notes:
 *
 * - EACH MIGRATION RUNS IN ITS OWN TRANSACTION, together with the bookkeeping
 *   row that records it. A migration that fails leaves the database exactly as
 *   it was, and never leaves `schema_migrations` claiming a half-applied
 *   migration succeeded. (Postgres has transactional DDL; this is the main
 *   reason plain .sql migrations against Postgres are safe to hand-run.)
 *
 * - Files are executed as a single multi-statement query rather than split on
 *   semicolons. Splitting is what breaks the moment a migration contains a
 *   dollar-quoted function body or a DO block — and this schema contains
 *   several. The server parses the batch; we do not attempt to.
 *
 * - A checksum of each file is stored. If a migration that has already been
 *   applied is later edited, `up` refuses to run rather than silently drifting
 *   from what is actually in the database.
 *
 * - `down` walks the applied list backwards and requires the matching
 *   `.down.sql` to exist. CI runs up -> down -> up on a scratch database, which
 *   is what keeps the down migrations honest.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'db',
  'migrations',
)

interface Migration {
  readonly id: string
  readonly upPath: string
  readonly downPath: string | null
}

interface AppliedMigration {
  readonly id: string
  readonly checksum: string
  readonly appliedAt: Date
}

const CREATE_TRACKING_TABLE = `
  create table if not exists schema_migrations (
    id          text primary key,
    checksum    text not null,
    applied_at  timestamptz not null default now(),
    duration_ms integer
  )
`

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function discoverMigrations(): Promise<Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR)
  const ids = new Set<string>()

  for (const entry of entries) {
    if (entry.endsWith('.up.sql')) ids.add(entry.slice(0, -'.up.sql'.length))
  }

  const migrations: Migration[] = []
  for (const id of ids) {
    const downFile = `${id}.down.sql`
    migrations.push({
      id,
      upPath: path.join(MIGRATIONS_DIR, `${id}.up.sql`),
      downPath: entries.includes(downFile) ? path.join(MIGRATIONS_DIR, downFile) : null,
    })
  }

  // Lexical order over the NNNN_ prefix is the migration order.
  migrations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return migrations
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

async function readApplied(client: Client): Promise<AppliedMigration[]> {
  await client.query(CREATE_TRACKING_TABLE)
  const result = await client.query<{ id: string; checksum: string; applied_at: Date }>(
    'select id, checksum, applied_at from schema_migrations order by id asc',
  )
  return result.rows.map((r) => ({ id: r.id, checksum: r.checksum, appliedAt: r.applied_at }))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandUp(client: Client): Promise<void> {
  const migrations = await discoverMigrations()
  const applied = await readApplied(client)
  const appliedById = new Map(applied.map((a) => [a.id, a]))

  // Drift check before doing anything, so we fail before a partial run.
  for (const migration of migrations) {
    const record = appliedById.get(migration.id)
    if (record === undefined) continue
    const sum = checksum(await readFile(migration.upPath, 'utf8'))
    if (sum !== record.checksum) {
      throw new Error(
        `Migration ${migration.id} has been modified since it was applied ` +
          `(recorded ${record.checksum}, file ${sum}). Applied migrations are immutable — ` +
          `write a new migration instead of editing this one.`,
      )
    }
  }

  const pending = migrations.filter((m) => !appliedById.has(m.id))
  if (pending.length === 0) {
    console.log('Nothing to apply — schema is up to date.')
    return
  }

  for (const migration of pending) {
    const sql = await readFile(migration.upPath, 'utf8')
    const startedAt = Date.now()
    process.stdout.write(`  applying ${migration.id} ... `)

    try {
      await client.query('begin')
      await client.query(sql)
      await client.query(
        'insert into schema_migrations (id, checksum, duration_ms) values ($1, $2, $3)',
        [migration.id, checksum(sql), Date.now() - startedAt],
      )
      await client.query('commit')
      console.log(`ok (${Date.now() - startedAt}ms)`)
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      console.log('FAILED')
      throw new Error(
        `Migration ${migration.id} failed and was rolled back: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  console.log(`Applied ${pending.length} migration(s).`)
}

async function commandDown(client: Client, count: number): Promise<void> {
  const migrations = await discoverMigrations()
  const byId = new Map(migrations.map((m) => [m.id, m]))
  const applied = await readApplied(client)

  if (applied.length === 0) {
    console.log('Nothing to roll back.')
    return
  }

  const target = applied.slice(-count).reverse()

  for (const record of target) {
    const migration = byId.get(record.id)
    if (migration === undefined) {
      throw new Error(
        `Migration ${record.id} is recorded as applied but its files are missing. ` +
          `Restore them before rolling back.`,
      )
    }
    if (migration.downPath === null) {
      throw new Error(`Migration ${record.id} has no .down.sql — cannot roll back.`)
    }

    const sql = await readFile(migration.downPath, 'utf8')
    const startedAt = Date.now()
    process.stdout.write(`  reverting ${record.id} ... `)

    try {
      await client.query('begin')
      await client.query(sql)
      await client.query('delete from schema_migrations where id = $1', [record.id])
      await client.query('commit')
      console.log(`ok (${Date.now() - startedAt}ms)`)
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      console.log('FAILED')
      throw new Error(
        `Rollback of ${record.id} failed and was itself rolled back: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  console.log(`Reverted ${target.length} migration(s).`)
}

async function commandStatus(client: Client): Promise<void> {
  const migrations = await discoverMigrations()
  const applied = await readApplied(client)
  const appliedById = new Map(applied.map((a) => [a.id, a]))

  for (const migration of migrations) {
    const record = appliedById.get(migration.id)
    const mark = record === undefined ? 'pending' : record.appliedAt.toISOString()
    const down = migration.downPath === null ? '  (no down migration!)' : ''
    console.log(`  ${migration.id.padEnd(28)} ${mark}${down}`)
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [, , command = 'up', arg] = process.argv

  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Point it at the Postgres connection string for the target database ' +
        '(Supabase: Project settings -> Database -> Connection string -> URI).',
    )
  }

  // Supabase requires TLS; `rejectUnauthorized: false` matches what the
  // Supabase connection string implies (their pooler presents a certificate
  // that is not in Node's default trust store). Set PGSSLMODE=disable for a
  // local docker database.
  const useSsl = process.env.PGSSLMODE !== 'disable'
  const client = new Client({
    connectionString,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  })

  await client.connect()
  try {
    switch (command) {
      case 'up':
        await commandUp(client)
        break
      case 'down': {
        const count = arg === undefined ? 1 : Number.parseInt(arg, 10)
        if (!Number.isFinite(count) || count < 1) {
          throw new Error(`down expects a positive integer, got '${String(arg)}'`)
        }
        await commandDown(client, count)
        break
      }
      case 'status':
        await commandStatus(client)
        break
      default:
        throw new Error(`Unknown command '${command}'. Use: up | down <n> | status`)
    }
  } finally {
    await client.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

/**
 * Client-safe UI helpers. No I/O, no environment access — these run
 * identically on server and client.
 */

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** 0..1 → "63.4%" */
export function formatPct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

/** Signed probability points: 0.123 → "+12.3pp", -0.04 → "−4.0pp" */
export function formatSignedPp(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  const pp = value * 100
  const sign = pp > 0 ? '+' : pp < 0 ? '−' : ''
  return `${sign}${Math.abs(pp).toFixed(digits)}pp`
}

/** Signed percentage: 2.41 → "+2.41%" (input already in percent units). */
export function formatSignedPct(valuePct: number, digits = 2): string {
  if (!Number.isFinite(valuePct)) return '—'
  const sign = valuePct > 0 ? '+' : valuePct < 0 ? '−' : ''
  return `${sign}${Math.abs(valuePct).toFixed(digits)}%`
}

const compactUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
})

const fullUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})

const preciseUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 6,
})

export function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return compactUsd.format(value)
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  // Sub-dollar assets (DOGE, XRP at times) need more precision than cents.
  return Math.abs(value) < 1 ? preciseUsd.format(value) : fullUsd.format(value)
}

const compactNum = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return compactNum.format(value)
}

/** ISO string → short venue-close style label, e.g. "Mar 14, 21:00 UTC". */
export function formatUtcShort(iso: string | null): string {
  if (iso === null) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  })
  return `${date}, ${time} UTC`
}

/** Hours → "3h", "2.5d". */
export function formatHours(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '—'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`
  if (hours < 48) return `${Math.round(hours)}h`
  return `${(hours / 24).toFixed(1)}d`
}

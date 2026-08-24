/**
 * Presentational pieces of the Analyst briefing screen. Server-renderable —
 * no client JS beyond the links themselves.
 *
 * Every evidence-bearing line gets a source chip per DISTINCT source system,
 * linking to the screen where the underlying figures live. The chip is the
 * traceability contract made visible: no claim without a named source.
 */

import Link from 'next/link'
import type { AnalystSection, BriefingLine, EvidenceSource } from '@/engines/analyst/briefing'
import { cn } from '@/ui/lib'

const SOURCE_META: Readonly<
  Record<EvidenceSource, { label: string; href: string; className: string }>
> = {
  crypto: { label: 'CRYPTO', href: '/crypto', className: 'border-cyan-400/30 text-cyan-300/90' },
  sports: { label: 'SPORTS', href: '/sports', className: 'border-emerald-400/30 text-emerald-300/90' },
  news: { label: 'NEWS', href: '/news', className: 'border-amber-400/30 text-amber-300/90' },
  edge: { label: 'EDGE', href: '/edge', className: 'border-violet-400/30 text-violet-300/90' },
}

export function SourceChips({ line }: { readonly line: BriefingLine }) {
  const sources = [...new Set(line.evidence.map((e) => e.source))]
  if (sources.length === 0) return null
  return (
    <span className="ml-2 inline-flex translate-y-[-1px] gap-1 align-middle">
      {sources.map((s) => {
        const meta = SOURCE_META[s]
        // The chip's title lists the exact refs + values backing the line.
        const detail = line.evidence
          .filter((e) => e.source === s)
          .map((e) => `${e.ref}: ${e.value}`)
          .join(' · ')
        return (
          <Link
            key={s}
            href={meta.href}
            title={detail}
            className={cn(
              'rounded-sm border px-1 py-px text-[8px] font-semibold tracking-[0.14em] no-underline opacity-80 hover:opacity-100',
              meta.className,
            )}
          >
            {meta.label}
          </Link>
        )
      })}
    </span>
  )
}

export function BriefingLineView({
  line,
  className,
}: {
  readonly line: BriefingLine
  readonly className?: string
}) {
  return (
    <p className={cn('text-[13px] leading-relaxed text-vx-body', className)}>
      {line.text}
      <SourceChips line={line} />
    </p>
  )
}

export function SectionView({ section, index }: { readonly section: AnalystSection; readonly index: number }) {
  return (
    <section aria-label={section.title} className="border-t border-vx-border pt-3">
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-vx-caption">
        <span className="vx-num mr-2 text-vx-accent">{String(index + 1).padStart(2, '0')}</span>
        {section.title}
      </h2>
      <BriefingLineView line={section.headline} className="mb-2 font-medium text-vx-heading" />
      {section.bullets.length > 0 && (
        <ul className="space-y-1.5">
          {section.bullets.map((b, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-vx-border-strong" aria-hidden />
              <BriefingLineView line={b} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

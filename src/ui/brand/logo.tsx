import { useId } from 'react'

/**
 * PRAEVION brand assets — pure inline SVG, no external files or custom fonts.
 *
 * Mark anatomy (64×64 grid):
 *  - broken gradient ring (violet top-left → blue → cyan bottom) with two
 *    breaks: one at the top where the arrow apex pierces the circle, one at
 *    the lower-left where the P's blade exits.
 *  - upward arrow apex ("see before it happens") integrated at the top.
 *  - faceted, angular P built from sharp shards; metallic white→gray fill
 *    with a violet→blue edge accent on the descending blade.
 *
 * Gradient IDs are namespaced with `pv-` + a per-instance suffix (React
 * useId by default) so multiple marks on one page never collide.
 */

const VIOLET = '#7C3AED'
const BLUE = '#3B82FF'
const CYAN = '#00D4FF'

/* Ring: r=23 around (32,34), two arcs leaving a top break (68°→112°) for the
   apex and a lower-left break (235°→255°) that the P's blade points through. */
const RING_ARC_RIGHT = 'M40.62 12.67 A23 23 0 0 1 26.05 56.22'
const RING_ARC_LEFT = 'M18.81 52.84 A23 23 0 0 1 23.38 12.67'
/* Upward dart apex seated in the top break. */
const APEX = 'M32 3.6 L41 13.6 L32 10.3 L23 13.6 Z'
/* Faceted P: stem shard (blade tip lower-left), bowl shard, counter (evenodd hole). */
const P_GLYPH =
  'M26 19 L31.5 19 L31.5 45 L22.6 54.2 Z ' +
  'M31.5 19 L40.5 22.5 L43 29 L38.5 34.5 L31.5 36.3 Z ' +
  'M31.5 24 L36.3 25.6 L37.6 28.8 L35.1 31.2 L31.5 31.9 Z'
/* Lower slice of the stem, recoloured as the gradient edge accent. */
const P_BLADE_ACCENT = 'M23.68 43 L31.5 43 L31.5 45 L22.6 54.2 Z'

export interface LogoMarkProps {
  readonly size?: number
  /** Single-colour rendering (white) for gradient/flat backgrounds. */
  readonly mono?: boolean
  /** Override the auto-generated gradient-ID suffix (SSR/snapshot stability). */
  readonly idSuffix?: string
  readonly className?: string
  readonly title?: string
}

export function LogoMark({ size = 28, mono = false, idSuffix, className, title = 'Praevion' }: LogoMarkProps) {
  const autoId = useId()
  const sfx = idSuffix ?? autoId
  const ringId = `pv-ring-${sfx}`
  const metalId = `pv-metal-${sfx}`
  const edgeId = `pv-edge-${sfx}`

  const ringStroke = mono ? '#FFFFFF' : `url(#${ringId})`
  const glyphFill = mono ? '#FFFFFF' : `url(#${metalId})`
  const bladeFill = mono ? '#FFFFFF' : `url(#${edgeId})`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
      className={className}
      fill="none"
    >
      {!mono && (
        <defs>
          <linearGradient id={ringId} x1="8" y1="6" x2="44" y2="60" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={VIOLET} />
            <stop offset="0.22" stopColor={VIOLET} />
            <stop offset="0.6" stopColor={BLUE} />
            <stop offset="1" stopColor={CYAN} />
          </linearGradient>
          <linearGradient id={metalId} x1="24" y1="18" x2="40" y2="52" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#FFFFFF" />
            <stop offset="0.55" stopColor="#D4D4D8" />
            <stop offset="1" stopColor="#A1A1AA" />
          </linearGradient>
          <linearGradient id={edgeId} x1="23" y1="42" x2="32" y2="54" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={VIOLET} />
            <stop offset="1" stopColor={BLUE} />
          </linearGradient>
        </defs>
      )}
      <path d={RING_ARC_RIGHT} stroke={ringStroke} strokeWidth="4.5" />
      <path d={RING_ARC_LEFT} stroke={ringStroke} strokeWidth="4.5" />
      <path d={APEX} fill={ringStroke === '#FFFFFF' ? '#FFFFFF' : `url(#${ringId})`} />
      <path d={P_GLYPH} fill={glyphFill} fillRule="evenodd" />
      <path d={P_BLADE_ACCENT} fill={bladeFill} />
    </svg>
  )
}

const WORDMARK_FONT = "'Arial Black', 'Arial Bold', Arial, 'Helvetica Neue', system-ui, sans-serif"

export interface WordmarkProps {
  /** Font size (px) of the PRAEVION line. */
  readonly size?: number
  /** Hide the "BY VIXERA AI" sub-line (tight spots, e.g. mobile). */
  readonly byline?: boolean
  readonly className?: string
}

/** PRAEVION wordmark: wide-tracked heavy caps, power-button O, gradient byline. */
export function Wordmark({ size = 13, byline = true, className }: WordmarkProps) {
  const cap = Math.round(size * 0.74)
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', flexDirection: 'column', gap: Math.max(3, size * 0.3), lineHeight: 1 }}
    >
      <span
        aria-label="PRAEVION"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          fontFamily: WORDMARK_FONT,
          fontWeight: 900,
          fontSize: size,
          letterSpacing: '0.3em',
          color: '#FFFFFF',
          lineHeight: 1,
          whiteSpace: 'nowrap',
        }}
      >
        <span aria-hidden>PRAEVI</span>
        {/* The O as a power-button motif — cyan ring, broken at top, tick through the gap. */}
        <svg
          width={cap}
          height={cap}
          viewBox="0 0 20 20"
          aria-hidden
          fill="none"
          style={{ marginRight: '0.3em', flexShrink: 0 }}
        >
          <path d="M14.55 4.95 A6.8 6.8 0 1 1 5.45 4.95" stroke={CYAN} strokeWidth="3.6" />
          <path d="M10 0.9 L10 8.6" stroke={CYAN} strokeWidth="3.6" />
        </svg>
        <span aria-hidden style={{ letterSpacing: 0 }}>N</span>
      </span>
      {byline && (
        <span
          style={{
            fontSize: Math.max(7, Math.round(size * 0.54)),
            letterSpacing: '0.44em',
            fontWeight: 700,
            fontFamily: WORDMARK_FONT,
            whiteSpace: 'nowrap',
            backgroundImage: `linear-gradient(90deg, ${VIOLET}, ${BLUE})`,
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          BY VIXERA AI
        </span>
      )}
    </span>
  )
}

export interface LogoLockupProps {
  readonly markSize?: number
  readonly textSize?: number
  readonly byline?: boolean
  readonly idSuffix?: string
  readonly className?: string
}

/** Horizontal mark + wordmark lockup for the app chrome. */
export function LogoLockup({ markSize = 28, textSize = 12, byline = true, idSuffix, className }: LogoLockupProps) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(markSize * 0.36) }}>
      <LogoMark size={markSize} idSuffix={idSuffix} />
      <Wordmark size={textSize} byline={byline} />
    </span>
  )
}

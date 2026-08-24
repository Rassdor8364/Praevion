import type { Metadata } from 'next'
import { MarketListScreen } from '../MarketListScreen'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Polymarket Markets' }

export default function PolymarketMarketsPage() {
  return <MarketListScreen venue="polymarket" heading="Prediction Markets — Polymarket" />
}

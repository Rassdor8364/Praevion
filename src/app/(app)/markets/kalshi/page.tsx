import type { Metadata } from 'next'
import { MarketListScreen } from '../MarketListScreen'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Kalshi Markets' }

export default function KalshiMarketsPage() {
  return <MarketListScreen venue="kalshi" heading="Prediction Markets — Kalshi" />
}

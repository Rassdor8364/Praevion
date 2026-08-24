import type { Metadata } from 'next'
import { MarketListScreen } from './MarketListScreen'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Prediction Markets' }

export default function MarketsPage() {
  return <MarketListScreen heading="Prediction Markets — All Venues" />
}

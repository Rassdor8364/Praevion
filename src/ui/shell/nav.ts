/** Sidebar navigation model — product brief §3 sections. Client-safe. */

import type { LucideIcon } from 'lucide-react'
import {
  BarChart3,
  Bitcoin,
  Bot,
  Eye,
  FlaskConical,
  Landmark,
  LayoutDashboard,
  Newspaper,
  Radar,
  Settings,
  Trophy,
  Users,
  Zap,
} from 'lucide-react'

export interface NavChild {
  readonly href: string
  readonly label: string
}

export interface NavItem {
  readonly href: string
  readonly label: string
  readonly icon: LucideIcon
  readonly children?: readonly NavChild[]
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Command Center', icon: LayoutDashboard },
  {
    href: '/markets',
    label: 'Prediction Markets',
    icon: Landmark,
    children: [
      { href: '/markets', label: 'All' },
      { href: '/markets/kalshi', label: 'Kalshi' },
      { href: '/markets/polymarket', label: 'Polymarket' },
    ],
  },
  { href: '/crypto', label: 'Crypto Futures', icon: Bitcoin },
  { href: '/sports', label: 'Sports', icon: Trophy },
  { href: '/consensus', label: 'Consensus', icon: Users },
  { href: '/edge', label: 'Vixera Edge', icon: Zap },
  { href: '/news', label: 'News', icon: Newspaper },
  { href: '/signals', label: 'Signals', icon: Radar },
  { href: '/watchlist', label: 'Watchlist', icon: Eye },
  { href: '/analyst', label: 'AI Analyst', icon: Bot },
  { href: '/backtesting', label: 'Backtesting', icon: FlaskConical },
  { href: '/performance', label: 'Model Performance', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
]

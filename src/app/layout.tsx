import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: {
    default: 'Praevion — Predictive Intelligence',
    template: '%s · Praevion',
  },
  description:
    'See before it happens. Predictive intelligence by Vixera AI — probabilistic market analysis across crypto, prediction markets, sports, and futures.',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Praevion',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    apple: '/apple-touch-icon.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#0B0E14',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} bg-vx-bg text-vx-body antialiased`}>
        {children}
      </body>
    </html>
  )
}

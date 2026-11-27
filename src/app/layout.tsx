import type { Metadata } from 'next'
import { getSettings } from '@/lib/settings'
import './globals.css'

export const dynamic = 'force-dynamic'

// Page titles end with the tagline from Settings (Branding), else the name.
export function generateMetadata(): Metadata {
  const s = getSettings()
  const brand = s.brandTagline || s.brandName
  return { title: { default: brand, template: `%s · ${brand}` } }
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}

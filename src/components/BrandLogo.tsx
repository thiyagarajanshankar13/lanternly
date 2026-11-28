import { getSettings } from '@/lib/settings'

// The logo from Settings (Branding), or a plain built-in mark when none is set.
export function BrandLogo({ width, height, className, style }: { width: number; height: number; className?: string; style?: React.CSSProperties }) {
  const s = getSettings()
  if (s.brandLogoUrl) return <img src={s.brandLogoUrl} width={width} height={height} alt={s.brandName} className={className} style={style} />
  // The Lanternly lantern: amber frame (deeper amber on light backgrounds, see .lantern in globals.css), dark glass, a flame.
  return (
    <svg viewBox="12 4 40 54" width={width} height={height} className={`lantern${className ? ` ${className}` : ''}`} style={style} role="img" aria-label={s.brandName}>
      <defs><linearGradient id="lantern-flame" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fde68a" /><stop offset="0.45" stopColor="#fbbf24" /><stop offset="1" stopColor="#d97706" /></linearGradient></defs>
      <path d="M26 12a6 6 0 0 1 12 0" fill="none" stroke="var(--lantern)" strokeWidth="3.5" strokeLinecap="round" />
      <rect x="19" y="12" width="26" height="6" rx="3" fill="var(--lantern)" />
      <rect x="16.5" y="19.5" width="31" height="30" rx="9" fill="#1c1c20" stroke="var(--lantern)" strokeWidth="3" />
      <path d="M32 25c5 6 7 10 7 14a7 7 0 0 1-14 0c0-4 2-8 7-14z" fill="url(#lantern-flame)" />
      <rect x="20" y="51" width="24" height="5" rx="2.5" fill="var(--lantern)" />
    </svg>
  )
}

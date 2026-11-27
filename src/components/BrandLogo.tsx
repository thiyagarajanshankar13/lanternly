import { getSettings } from '@/lib/settings'

// The logo from Settings (Branding), or a plain built-in mark when none is set.
export function BrandLogo({ width, height, className, style }: { width: number; height: number; className?: string; style?: React.CSSProperties }) {
  const s = getSettings()
  if (s.brandLogoUrl) return <img src={s.brandLogoUrl} width={width} height={height} alt={s.brandName} className={className} style={style} />
  // Three stacked layers: services on servers.
  return (
    <svg viewBox="0 0 30 26" width={width} height={height} className={className} style={style} role="img" aria-label={s.brandName}>
      <path d="M15 2 28 8.5 15 15 2 8.5Z" fill="var(--accent, #be1279)" />
      <path d="M4.5 12.3 15 17.5l10.5-5.2L28 13.5 15 20 2 13.5Z" fill="currentColor" opacity=".55" />
      <path d="M4.5 17.3 15 22.5l10.5-5.2L28 18.5 15 25 2 18.5Z" fill="currentColor" opacity=".3" />
    </svg>
  )
}

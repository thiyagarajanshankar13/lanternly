'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/** Reloads the page's data every so often while the tab is in view. */
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter()
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') router.refresh() }, seconds * 1000)
    return () => clearInterval(timer)
  }, [router, seconds])
  return null
}

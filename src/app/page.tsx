import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { publicPage } from '@/plugins/parts'

// The front page: a plugin's public page when one that has one is on (the
// Avrosphere plugin's avro.site page), else straight to the admin.

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  return publicPage()?.metadata ?? {}
}

export default function Home() {
  const page = publicPage()
  if (!page) redirect('/admin')
  return <page.Page />
}

import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { homePage } from '@/lib/access'

// /admin itself opens the home page: Projects for everyone who can see it.
export default async function AdminHome() {
  redirect(homePage(await requireAdmin()))
}

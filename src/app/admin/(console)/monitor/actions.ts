'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { canSeeSite, isOwner } from '@/lib/access'
import { audit } from '@/lib/audit'
import { requireOwner } from '@/lib/guards'
import { mailReady, sendMail } from '@/lib/mail'
import { addWatched, alertRecipients, checkSite, cleanSiteUrl, getWatched, refreshStats, removeWatched, runDueChecks, setStatsKey, updateWatched, urlWatched } from '@/lib/monitor'
import { saveLabels, setSiteLabels } from '@/lib/monitorLabels'
import { saveSettings, deployerTitle } from '@/lib/settings'
import { isEmail } from '@/lib/validate'

type FormState = { error?: string; ok?: string } | undefined
const str = (form: FormData, key: string) => String(form.get(key) ?? '').trim()

export async function addWatchedAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const url = cleanSiteUrl(str(form, 'url'))
  if (!url) return { error: 'Enter the web address of the site, like https://www.example.com.' }
  if (urlWatched(url)) return { error: 'That address is already on the list.' }
  const name = str(form, 'name').slice(0, 80) || new URL(url).hostname
  const site = addWatched(name, url)
  await audit(admin, 'monitoring', { detail: `Watching ${url}` })
  const after = await checkSite(site.id, { cert: true })
  revalidatePath('/admin/monitor')
  if (after?.lastError) return { ok: `${name} added, but the first check failed: ${after.lastError}` }
  return { ok: `${name} added. It answered in ${after?.lastMs ?? '?'} ms${after?.version ? ` and runs version ${after.version}` : after?.hasHealth ? '' : ' (no version: the site has no /api/health, so its home page is checked)'}.` }
}

export async function saveWatchedAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const id = Number(str(form, 'id'))
  const site = getWatched(id)
  if (!site) return { error: 'That site is no longer on the list.' }
  const paused = form.get('paused') === 'on'
  // Forms with the Labels field send labelsField, so a form without it leaves labels alone.
  if (form.get('labelsField')) {
    const result = setSiteLabels(id, form.getAll('labels').map(String))
    if (result.error) return { error: result.error }
    if (result.added.length) await audit(admin, 'monitoring', { detail: `New label${result.added.length === 1 ? '' : 's'} ${result.added.join(', ')}` })
  }
  if (site.clubId !== null) {
    // Name and address of a deployer site follow the site itself.
    updateWatched(id, { paused })
  } else {
    const url = cleanSiteUrl(str(form, 'url'))
    if (!url) return { error: 'Enter the web address of the site, like https://www.example.com.' }
    if (urlWatched(url, id)) return { error: 'That address is already on the list.' }
    const statsKey = str(form, 'statsKey')
    if (statsKey && (statsKey.length < 16 || statsKey.length > 200 || /\s/.test(statsKey))) return { error: 'The key should be 16 or more characters, with no spaces.' }
    updateWatched(id, { name: str(form, 'name').slice(0, 80) || new URL(url).hostname, url, paused })
    if (form.get('clearStatsKey') === 'on') setStatsKey(id, '')
    else if (statsKey) {
      setStatsKey(id, statsKey)
      await refreshStats(id)
      const after = getWatched(id)
      revalidatePath('/admin/monitor')
      revalidatePath(`/admin/monitor/${id}`)
      if (after?.statsError) return { error: `Saved, but the numbers could not be read: ${after.statsError}` }
      return { ok: `Saved. The site has ${after?.members ?? 0} members and ${after?.staff ?? 0} staff.` }
    }
  }
  revalidatePath('/admin/monitor')
  revalidatePath(`/admin/monitor/${id}`)
  return { ok: 'Saved.' }
}

export async function checkNowAction(form: FormData) {
  const admin = await requireAdmin()
  const id = Number(str(form, 'id'))
  if (id) {
    // Anyone who can see the site may check it again; outside sites are owners'.
    const site = getWatched(id)
    if (!site || !(isOwner(admin) || canSeeSite(admin, site.clubId))) return
    await checkSite(id, { cert: true, stats: true })
  } else if (isOwner(admin)) await runDueChecks({ force: true })
  revalidatePath('/admin/monitor')
  if (id) revalidatePath(`/admin/monitor/${id}`)
}

export async function removeWatchedAction(form: FormData) {
  const admin = await requireOwner()
  const gone = getWatched(Number(str(form, 'id')))
  if (!gone) return
  removeWatched(gone.id)
  await audit(admin, 'monitoring', { detail: `Stopped watching ${gone.url}` })
  revalidatePath('/admin/monitor')
  redirect('/admin/monitor')
}

export async function saveAlertSettingsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const emails = str(form, 'alertEmails').split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
  const bad = emails.find((e) => !isEmail(e))
  if (bad) return { error: `"${bad}" doesn't look like an email address.` }
  const monitorMinutes = Number(str(form, 'monitorMinutes'))
  if (!(Number.isInteger(monitorMinutes) && monitorMinutes >= 1 && monitorMinutes <= 60)) return { error: 'Check every 1 to 60 minutes.' }
  saveSettings({ alertEmails: emails.join(', '), monitorMinutes })
  await audit(admin, 'monitoring', { detail: `Alerts to ${emails.join(', ') || 'every owner'}, every ${monitorMinutes} min` })
  revalidatePath('/admin/monitor')
  if (str(form, 'intent') === 'test') {
    if (!mailReady()) return { error: 'Saved, but no test was sent: set up outgoing email under Settings first.' }
    const to = alertRecipients()
    const error = await sendMail(to, `Test alert from ${deployerTitle()}`, 'This is a test. Monitoring alerts (a site down, back up, or a certificate about to expire) will arrive like this one.')
    return error ? { error: `Saved, but the test email failed: ${error}` } : { ok: `Saved. Test email sent to ${to.join(', ')}.` }
  }
  return { ok: 'Saved.' }
}

export async function saveLabelsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const ids = form.getAll('labelId').map(Number).filter((n) => Number.isInteger(n) && n > 0)
  const edits = ids.map((id) => ({ id, name: str(form, `name-${id}`), color: str(form, `color-${id}`), remove: form.get(`remove-${id}`) === 'on' }))
  const newName = str(form, 'newLabel')
  const result = saveLabels(edits, ids, newName)
  if (result.error) return { error: result.error }
  const parts = [result.removed.length ? `deleted ${result.removed.join(', ')}` : '', newName ? `added ${newName}` : ''].filter(Boolean)
  await audit(admin, 'monitoring', { detail: `Labels saved${parts.length ? `: ${parts.join('; ')}` : ''}` })
  revalidatePath('/admin/monitor')
  return { ok: result.removed.length ? `Labels saved. ${result.removed.join(', ')} ${result.removed.length === 1 ? 'was' : 'were'} taken off ${result.removed.length === 1 ? 'its' : 'their'} sites.` : 'Labels saved.' }
}

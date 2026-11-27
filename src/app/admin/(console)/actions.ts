'use server'

import dns from 'node:dns/promises'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isOwner } from '@/lib/access'
import { audit } from '@/lib/audit'
import { requireOwner, siteFor } from '@/lib/guards'
import { getPlugin, isPluginId, setPluginOn } from '@/plugins'
import {
  deleteClubRow, deleteServer, domainInUse, getClub, getClubByName, getServer, saveServer, updateClub } from '@/lib/clubs'
import { serverBusy, serviceKind } from '@/plugins/server'
import { appsUsing } from '@/lib/services'
import { enqueue, hasPendingOperation } from '@/lib/ops'
import { getSettings, saveSettings } from '@/lib/settings'
import { cleanDomain, clubNameError, isDomain, isEmail, isImage } from '@/lib/validate'

export type FormState = { error?: string; ok?: string } | undefined

const str = (form: FormData, key: string) => String(form.get(key) ?? '').trim()

// ── Sites ────────────────────────────────────────────────────────────────────
/** Does the domain point at the club's server yet? */
async function pointsAt(domain: string, ip: string): Promise<boolean | null> {
  if (!ip) return null
  try {
    const found = await Promise.race([
      dns.resolve4(domain),
      new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ])
    return found.includes(ip)
  } catch {
    return false
  }
}

export async function addDomainAction(_prev: FormState, form: FormData): Promise<FormState> {
  const found = await siteFor(Number(str(form, 'id')), 'operate')
  if (!found) return { error: 'That site no longer exists.' }
  const { admin, club } = found
  if (hasPendingOperation(club.id)) return { error: 'Wait for the current change to finish first.' }
  const domain = cleanDomain(str(form, 'domain'))
  const platform = getSettings()
  if (!isDomain(domain)) return { error: 'Enter a domain like www.example.com.' }
  if (domain === platform.baseDomain || domain.endsWith(`.${platform.baseDomain}`)) return { error: `Addresses under ${platform.baseDomain} are assigned automatically.` }
  if (club.customDomains.includes(domain) || domainInUse(domain, club.id)) return { error: 'That domain is already connected to a site.' }
  if (club.customDomains.length >= 8) return { error: 'A site can have up to 8 custom domains.' }
  const server = getServer(club.serverId)
  const ok = await pointsAt(domain, server?.public_ip || '')
  if (ok === false && form.get('force') !== 'on') {
    return { error: `${domain} doesn't point at this site's server yet. Add the DNS record below, wait a few minutes and try again (or tick "Add anyway").` }
  }
  // The first custom domain becomes the site's main address.
  updateClub(club.id, { customDomains: [...club.customDomains, domain] })
  enqueue(getClub(club.id)!, 'configure', admin.email)
  revalidatePath(`/admin/clubs/${club.id}`)
  return { ok: `${domain} added. Its HTTPS certificate is requested in the next minute${ok === false ? ", but that only works once the DNS record points at the server: after fixing DNS, press Retry HTTPS under Addresses" : ''}.` }
}

export async function removeDomainAction(form: FormData) {
  const found = await siteFor(Number(str(form, 'id')), 'operate')
  if (!found || hasPendingOperation(found.club.id)) return
  const { admin, club } = found
  const domain = str(form, 'domain')
  if (!club.customDomains.includes(domain)) return
  updateClub(club.id, { customDomains: club.customDomains.filter((d) => d !== domain) })
  enqueue(getClub(club.id)!, 'configure', admin.email)
  revalidatePath(`/admin/clubs/${club.id}`)
}

export async function makePrimaryDomainAction(form: FormData) {
  const found = await siteFor(Number(str(form, 'id')), 'operate')
  if (!found || hasPendingOperation(found.club.id)) return
  const { admin, club } = found
  const domain = str(form, 'domain')
  if (!club.customDomains.includes(domain)) return
  updateClub(club.id, { customDomains: [domain, ...club.customDomains.filter((d) => d !== domain)] })
  enqueue(getClub(club.id)!, 'configure', admin.email)
  revalidatePath(`/admin/clubs/${club.id}`)
}

export async function clubOperationAction(form: FormData) {
  const found = await siteFor(Number(str(form, 'id')), 'operate')
  if (!found) return
  const { admin, club } = found
  const kind = str(form, 'kind')
  // Starting a failed site over is creating it: owners only.
  if (kind === 'retry-create' && !isOwner(admin)) return
  if (hasPendingOperation(club.id)) return
  // A database changes version and starts over from its own page (other wording, other checks).
  if (club.kind === 'postgres' && (kind === 'upgrade' || kind === 'retry-create')) return
  if (kind === 'pause' && club.status === 'running') enqueue(club, 'pause', admin.email)
  else if (kind === 'resume' && club.status === 'paused') enqueue(club, 'resume', admin.email)
  else if (kind === 'https' && (club.status === 'running' || club.status === 'paused') && club.customDomains.length) enqueue(club, 'https', admin.email)
  else if (kind === 'backup' && (club.status === 'running' || club.status === 'paused')) enqueue(club, 'backup', admin.email)
  else if (kind === 'upgrade' && (club.status === 'running' || club.status === 'paused')) {
    // The kind's plugin reads the version picked (Avrosphere: a release or a typed image).
    const image = serviceKind(club.kind)?.upgradeImage?.(form) ?? str(form, 'image')
    if (image && isImage(image)) enqueue(club, 'upgrade', admin.email, { image })
  } else if (kind === 'retry-create' && club.status === 'failed') {
    // The failed attempt cleaned up after itself on the server, so start over.
    const password = String(form.get('ownerPassword') ?? '')
    if (password.length < 10) return
    updateClub(club.id, { status: 'creating' })
    enqueue(getClub(club.id)!, 'create', admin.email, { adminEmail: club.ownerEmail, adminPassword: password, adminName: club.ownerName })
  }
  revalidatePath(`/admin/clubs/${club.id}`)
}

export async function removeClubAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const club = getClub(Number(str(form, 'id')))
  if (!club) return { error: 'That site no longer exists.' }
  if (str(form, 'confirm') !== club.name) return { error: `Type ${club.name} to confirm.` }
  if (hasPendingOperation(club.id)) return { error: 'Wait for the current change to finish first.' }
  if (club.kind === 'postgres') {
    const users = appsUsing(club.id)
    if (users.length) return { error: `${users.map((a) => a.displayName).join(', ')} still ${users.length === 1 ? 'uses' : 'use'} this database. Disconnect ${users.length === 1 ? 'it' : 'them'} in the app's settings first.` }
  }
  if (club.status === 'failed' && form.get('recordOnly') === 'on') {
    deleteClubRow(club.id)
    redirect('/admin')
  }
  updateClub(club.id, { status: 'removing' })
  enqueue(getClub(club.id)!, 'remove', admin.email)
  redirect(`/admin/clubs/${club.id}`)
}

// ── Servers ──────────────────────────────────────────────────────────────────
export async function saveServerAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const name = str(form, 'name')
  const host = str(form, 'host').toLowerCase()
  const hostKey = str(form, 'hostKey')
  const publicIp = str(form, 'publicIp')
  const port = Number(str(form, 'port')) || 22
  const maxClubs = Number(str(form, 'maxClubs'))
  const editing = Number(str(form, 'id')) || 0
  const busy = editing ? serverBusy(editing) : null
  if (busy) return { error: busy }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}$/.test(name)) return { error: 'Give the server a short name.' }
  if (!/^[a-z0-9.-]+$/.test(host)) return { error: 'Enter the server address (a hostname or IP).' }
  if (!/AAAA[A-Za-z0-9+/=]+/.test(hostKey)) return { error: 'Paste the host key that setup-clubs-vm.sh printed (starts with ssh-ed25519 AAAA…).' }
  if (publicIp && !/^\d{1,3}(\.\d{1,3}){3}$/.test(publicIp)) return { error: 'The public IP should look like 13.54.1.2.' }
  if (!(maxClubs >= 1 && maxClubs <= 500)) return { error: 'Set how many sites this server may hold.' }
  const memoryMb = Number(str(form, 'memoryMb') || '0')
  if (!(memoryMb === 0 || (memoryMb >= 1024 && memoryMb <= 1_048_576))) return { error: 'Memory is the server\'s RAM in MB (for example 8192), or leave it empty.' }
  try {
    saveServer({ id: Number(str(form, 'id')) || undefined, name, host, port, username: str(form, 'username') || 'deployer', hostKey, publicIp, maxClubs, acceptsNew: form.get('acceptsNew') === 'on', memoryMb })
  } catch {
    return { error: 'A server with that name already exists.' }
  }
  await audit(admin, 'server', { detail: `Saved ${name} (${host})` })
  revalidatePath('/admin/servers')
  return { ok: 'Saved.' }
}

export async function deleteServerAction(form: FormData) {
  const admin = await requireOwner()
  const server = getServer(Number(str(form, 'id')))
  if (!server) return
  deleteServer(server.id)
  await audit(admin, 'server', { detail: `Removed ${server.name}` })
  revalidatePath('/admin/servers')
}

// ── Settings ──────────────────────────────────────────────────────
export async function saveSettingsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const baseDomain = cleanDomain(str(form, 'baseDomain'))
  if (!isDomain(baseDomain)) return { error: 'Enter the domain services live under, like apps.example.com.' }
  const smtpFromAddress = str(form, 'smtpFromAddress')
  if (smtpFromAddress && !isEmail(smtpFromAddress)) return { error: 'The sender address should be an email address.' }
  const smtpPass = String(form.get('smtpPass') ?? '')
  saveSettings({
    baseDomain, defaultTimezone: str(form, 'defaultTimezone') || 'UTC',
    smtpHost: str(form, 'smtpHost'), smtpPort: str(form, 'smtpPort') || '587', smtpUser: str(form, 'smtpUser'), smtpFromAddress,
    ...(smtpPass ? { smtpPass } : {}),
  })
  await audit(admin, 'settings', { detail: smtpPass ? 'Platform settings (email password changed)' : 'Platform settings' })
  revalidatePath('/admin/settings')
  return { ok: 'Saved. Existing sites pick up email and domain changes the next time their settings are applied.' }
}

// ── Plugins ──────────────────────────────────────────────────────────────────
export async function setPluginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const id = str(form, 'plugin')
  if (!isPluginId(id)) return { error: "That plugin isn't part of this deployer." }
  const on = str(form, 'on') === 'on'
  setPluginOn(id, on)
  await audit(admin, 'settings', { detail: `Plugin ${getPlugin(id)!.name} turned ${on ? 'on' : 'off'}` })
  revalidatePath('/admin', 'layout')
  return { ok: `${getPlugin(id)!.name} is ${on ? 'on' : 'off'}.` }
}

// ── Branding and region ──────────────────────────────────────────────────────
export async function saveBrandingAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const brandName = str(form, 'brandName').replace(/\s+/g, ' ')
  const brandTagline = str(form, 'brandTagline').replace(/\s+/g, ' ')
  const brandLogoUrl = str(form, 'brandLogoUrl')
  const locale = str(form, 'locale') || 'en-US'
  const extraReservedNames = str(form, 'extraReservedNames').toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (!brandName || brandName.length > 40) return { error: 'Give the deployer a name of up to 40 characters.' }
  if (brandTagline.length > 60) return { error: 'Keep the line under the name to 60 characters.' }
  if (brandLogoUrl && !(/^https:\/\/[^\s"'<>]{4,500}$/.test(brandLogoUrl) || /^\/[A-Za-z0-9._\/-]{1,200}$/.test(brandLogoUrl))) return { error: 'The logo is an https:// address or a path on this deployer, like /brand/logo.png.' }
  let localeOk = false
  try { localeOk = Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0 } catch { localeOk = false }
  if (!localeOk) return { error: 'The locale is a language tag such as en-US, en-GB or en-AU.' }
  const badName = extraReservedNames.find((n) => !/^[a-z][a-z0-9-]{0,30}$/.test(n))
  if (badName) return { error: `"${badName}" isn't a possible service name, so it doesn't need reserving.` }
  saveSettings({ brandName, brandTagline, brandLogoUrl, locale, extraReservedNames: extraReservedNames.join(' ') })
  await audit(admin, 'settings', { detail: 'Branding and region' })
  revalidatePath('/admin', 'layout')
  return { ok: 'Saved.' }
}

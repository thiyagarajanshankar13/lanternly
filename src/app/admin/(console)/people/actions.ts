'use server'
import { deployerTitle } from '@/lib/settings'
import { deployerUrl } from '@/lib/deployerUrl'

import { listProjects } from '@/lib/projects'

import { revalidatePath } from 'next/cache'
import {
  type AccessInput, deleteAdmin, getAdmin, inviteAdmin, listAdmins, ownerCount, passwordError, renewInvite, resetTwoStep,
  setAccess, setAdminName, setAdminPassword, setSuspended,
} from '@/lib/auth'
import { type Admin } from '@/lib/auth'
import { accessChip, isRole, lastOwnerError } from '@/lib/access'
import { audit } from '@/lib/audit'
import { listClubs } from '@/lib/clubs'
import { requireAdmin } from '@/lib/auth'
import { requireOwner } from '@/lib/guards'
import { mailReady, sendMail } from '@/lib/mail'
import { isEmail } from '@/lib/validate'

type FormState = { error?: string; ok?: string } | undefined
const str = (form: FormData, key: string) => String(form.get(key) ?? '').trim()

function accessFrom(form: FormData): AccessInput | string {
  const role = str(form, 'role')
  if (!isRole(role)) return 'Pick a role.'
  const allSites = role === 'owner' || form.get('allSites') === 'on'
  const known = new Set(listClubs().map((c) => c.id))
  const siteIds = form.getAll('sites').map((v) => Number(v)).filter((id) => known.has(id))
  const projects = new Set(listProjects().map((p) => p.id))
  const projectIds = form.getAll('projects').map((v) => Number(v)).filter((id) => projects.has(id))
  if (!allSites && siteIds.length === 0 && projectIds.length === 0) return 'Pick at least one site or project, or tick "All sites and projects".'
  return { role, allSites, siteIds: allSites ? [] : siteIds, projectIds: allSites ? [] : projectIds }
}

function inviteLink(token: string) {
  return `${deployerUrl()}/admin/invite/${token}`
}

async function emailInvite(to: string, name: string, link: string, by: Admin): Promise<string | null> {
  if (!mailReady()) return 'no-mail'
  const title = deployerTitle()
  return sendMail([to], `You have been invited to ${title}`, [
    `Hi${name ? ` ${name.split(' ')[0]}` : ''},`,
    '',
    `${by.name || by.email} has invited you to ${title}.`,
    'Open this link to pick a password and set up two-step sign-in (it works once, for 72 hours):',
    '',
    link,
  ].join('\n'))
}

const describe = (a: AccessInput) => accessChip(a)

export async function invitePersonAction(_prev: FormState, form: FormData): Promise<FormState> {
  const me = await requireOwner()
  const email = str(form, 'email').toLowerCase()
  const name = str(form, 'name').slice(0, 80)
  if (!isEmail(email)) return { error: 'Enter a valid email address.' }
  if (listAdmins().some((a) => a.email === email)) return { error: 'That person is already on the list.' }
  const access = accessFrom(form)
  if (typeof access === 'string') return { error: access }
  const { token } = inviteAdmin(email, name, access, me.email)
  const link = inviteLink(token)
  await audit(me, 'invite', { detail: `${email} as ${describe(access)}` })
  revalidatePath('/admin/people')
  const sent = form.get('sendEmail') === 'on' ? await emailInvite(email, name, link, me) : 'not-asked'
  const mailNote = sent === null ? ` It was also emailed to ${email}.` : sent === 'no-mail' ? ' (Not emailed: set up outgoing email under Settings first.)' : sent !== 'not-asked' ? ` (The email failed: ${sent})` : ''
  return { ok: `Invited ${email}. Send them this link, which works once for 72 hours: ${link}${mailNote}` }
}

export async function savePersonAction(_prev: FormState, form: FormData): Promise<FormState> {
  const me = await requireOwner()
  const person = getAdmin(Number(str(form, 'id')))
  if (!person) return { error: 'That person is no longer on the list.' }
  const access = accessFrom(form)
  if (typeof access === 'string') return { error: access }
  if (person.id === me.id && access.role !== 'owner') return { error: "You can't take away your own owner role. Ask another owner." }
  const bad = lastOwnerError(ownerCount(), person, { role: access.role })
  if (bad) return { error: bad }
  const name = str(form, 'name').slice(0, 80)
  if (name !== person.name) setAdminName(person.id, name)
  const before = describe(person)
  setAccess(person.id, access)
  const after = describe(access)
  const sitesChanged = !access.allSites && (access.siteIds.join(',') !== person.siteIds.join(','))
  if (before !== after || sitesChanged) await audit(me, 'access-changed', { detail: `${person.email}: ${before} → ${after}` })
  revalidatePath('/admin/people')
  return { ok: `Saved. ${person.email} now has ${after}. It applies straight away.` }
}

export async function personMaintenanceAction(_prev: FormState, form: FormData): Promise<FormState> {
  const me = await requireOwner()
  const person = getAdmin(Number(str(form, 'id')))
  if (!person) return { error: 'That person is no longer on the list.' }
  const kind = str(form, 'kind')
  const self = person.id === me.id
  revalidatePath('/admin/people')
  if (kind === 'suspend' || kind === 'unsuspend') {
    if (self) return { error: "You can't suspend yourself." }
    const suspend = kind === 'suspend'
    const bad = suspend ? lastOwnerError(ownerCount(), person, { suspended: true }) : null
    if (bad) return { error: bad }
    setSuspended(person.id, suspend)
    await audit(me, suspend ? 'suspended' : 'unsuspended', { detail: person.email })
    return { ok: suspend ? `${person.email} is suspended and was signed out.` : `${person.email} can sign in again.` }
  }
  if (kind === 'remove') {
    if (self) return { error: "You can't remove yourself." }
    if (str(form, 'confirm').toLowerCase() !== person.email) return { error: `Type ${person.email} to confirm.` }
    const bad = lastOwnerError(ownerCount(), person, { removed: true })
    if (bad) return { error: bad }
    deleteAdmin(person.id)
    await audit(me, 'removed-person', { detail: person.email })
    return { ok: `${person.email} was removed and signed out.` }
  }
  if (kind === 'reset-two-step') {
    if (self) return { error: 'Ask another owner to reset your two-step sign-in.' }
    resetTwoStep(person.id)
    await audit(me, 'two-step-reset', { detail: person.email })
    return { ok: `${person.email} was signed out and sets up two-step sign-in again next time.` }
  }
  if (kind === 'renew-invite') {
    const token = renewInvite(person.id)
    if (!token) return { error: 'They already accepted their invite.' }
    const link = inviteLink(token)
    await audit(me, 'invite-renewed', { detail: person.email })
    const sent = form.get('sendEmail') === 'on' ? await emailInvite(person.email, person.name, link, me) : 'not-asked'
    const mailNote = sent === null ? ` It was also emailed to ${person.email}.` : sent === 'no-mail' ? ' (Not emailed: set up outgoing email under Settings first.)' : sent !== 'not-asked' ? ` (The email failed: ${sent})` : ''
    return { ok: `New link for ${person.email} (the old one no longer works): ${link}${mailNote}` }
  }
  return { error: 'Unknown action.' }
}

/** Anyone can change their own password; it signs them out everywhere. */
export async function changeOwnPasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  const me = await requireAdmin()
  const password = String(form.get('password') ?? '')
  const bad = passwordError(password)
  if (bad) return { error: bad }
  if (password !== String(form.get('password2') ?? '')) return { error: "The two passwords don't match." }
  setAdminPassword(me.id, password)
  await audit(me, 'password-changed')
  return { ok: 'Password changed. Sign in again with the new one.' }
}

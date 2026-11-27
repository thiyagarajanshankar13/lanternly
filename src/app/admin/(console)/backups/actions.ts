'use server'

import { getProject, pgVersionOf } from '@/lib/projects'
import { createDatabase } from '@/lib/postgres/service'
import { createStorage } from '@/lib/storage/service'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { checkCode, recordAttempt, tooManyAttempts } from '@/lib/auth'
import { audit } from '@/lib/audit'
import { requireOwner, siteFor } from '@/lib/guards'
import { getClub, getClubByName, getServer, insertClub, pickServer, updateClub, newNameError } from '@/lib/clubs'
import { randomPassword } from '@/lib/crypto'
import { enqueue, hasPendingOperation, newBatch } from '@/lib/ops'
import { getSettings, saveSettings } from '@/lib/settings'
import { getBackup } from '@/lib/backups/records'
import { backupKey, readManifest, reapplyKeep, type SavedSettings } from '@/lib/backups/run'
import { FREQUENT_CHOICES } from '@/lib/backups/schedule'
import { backupStore } from '@/lib/backups/store'
import { clubNameError } from '@/lib/validate'

type FormState = { error?: string; ok?: string } | undefined
const str = (form: FormData, key: string) => String(form.get(key) ?? '').trim()
const int = (form: FormData, key: string) => Math.round(Number(str(form, key)))
const days = (n: number) => Number.isFinite(n) && n >= 1 && n <= 3650

/** Restores replace live data: a fresh two-step code, with the usual attempt limit. */
function codeError(adminId: number, code: string): string | null {
  const key = `restore:${adminId}`
  if (tooManyAttempts(key, 5, 15)) return 'Too many wrong codes. Wait 15 minutes and try again.'
  if (!/^\d{6}$/.test(code.replace(/\s+/g, '')) || !checkCode(adminId, code.replace(/\s+/g, ''))) {
    recordAttempt(key)
    return 'That two-step code is not right.'
  }
  return null
}

export async function saveBucketAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const bucket = str(form, 'backupBucket')
  const region = str(form, 'backupRegion') || 'ap-southeast-2'
  const endpoint = str(form, 'backupEndpoint')
  if (bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return { error: 'A bucket name is 3 to 63 lower-case letters, digits, dots and dashes.' }
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) return { error: 'The region looks like ap-southeast-2 (Sydney).' }
  if (endpoint && !/^https?:\/\/[a-z0-9.:-]+\/?$/i.test(endpoint)) return { error: 'The endpoint must be a plain https:// address, or left empty.' }
  const accessKey = str(form, 'backupAccessKeyId')
  const secret = str(form, 'backupSecretAccessKey')
  const frequentHours = int(form, 'backupDefaultFrequentHours')
  const dailyHour = int(form, 'backupDefaultDailyHour')
  const frequentKeep = int(form, 'backupDefaultFrequentKeepDays')
  const dailyKeep = int(form, 'backupDefaultDailyKeepDays')
  const removedKeep = int(form, 'backupRemovedKeepDays')
  if (!(FREQUENT_CHOICES as readonly number[]).includes(frequentHours)) return { error: 'Pick how often for the frequent backups.' }
  if (!(dailyHour >= 0 && dailyHour <= 23)) return { error: 'Pick the hour for the daily backup.' }
  if (![frequentKeep, dailyKeep, removedKeep].every(days)) return { error: 'Keep periods are 1 to 3650 days.' }
  saveSettings({
    backupBucket: bucket, backupRegion: region, backupEndpoint: endpoint, backupAccessKeyId: accessKey,
    ...(secret ? { backupSecretAccessKey: secret } : {}),
    backupSaveImages: form.get('backupSaveImages') === 'on',
    backupDefaultFrequentHours: frequentHours, backupDefaultFrequentKeepDays: frequentKeep,
    backupDefaultDaily: form.get('backupDefaultDaily') === 'on', backupDefaultDailyHour: dailyHour, backupDefaultDailyKeepDays: dailyKeep,
    backupRemovedKeepDays: removedKeep,
  })
  if (bucket) backupKey() // made now so it can be shown and saved before the first backup
  await audit(admin, 'bucket', { detail: `${bucket || 'no bucket'}${secret ? ' (secret key replaced)' : ''}` })
  revalidatePath('/admin/backups')
  return { ok: 'Saved. Press "Test the bucket" to check the keys.' }
}

export async function testBucketAction(_prev: FormState): Promise<FormState> {
  await requireOwner()
  const store = backupStore()
  if (!store) return { error: 'Fill in the bucket name and both keys first.' }
  try {
    await store.check()
    return { ok: `The ${store.label} works: a test file was written, read back and deleted.` }
  } catch (err) {
    const e = err as Error & { name?: string; $metadata?: { httpStatusCode?: number } }
    const code = e.$metadata?.httpStatusCode
    const hint = code === 403 ? ' The keys were refused: check them, and that they have access to this bucket.' : code === 404 ? " There's no bucket with that name in that region." : ''
    return { error: `The bucket didn't work: ${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}.${hint}` }
  }
}

export async function keySavedAction(form: FormData) {
  await requireOwner()
  if (form.get('saved') === 'on') saveSettings({ backupKeySaved: true })
  revalidatePath('/admin/backups')
}

export async function showKeyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const err = codeError(admin.id, str(form, 'code'))
  if (err) return { error: err }
  if (!getSettings().backupKey) return { error: 'There is no backup key yet: save the bucket settings first.' }
  await audit(admin, 'backup-key-shown')
  return { ok: `Backup key: ${backupKey().toString('hex')}` }
}

export async function saveScheduleAction(_prev: FormState, form: FormData): Promise<FormState> {
  const found = await siteFor(Number(str(form, 'id')), 'operate')
  if (!found) return { error: 'That site no longer exists.' }
  const { club } = found
  const frequentHours = int(form, 'frequentHours')
  const dailyHour = int(form, 'dailyHour')
  const frequentKeep = int(form, 'frequentKeepDays')
  const dailyKeep = int(form, 'dailyKeepDays')
  if (!(FREQUENT_CHOICES as readonly number[]).includes(frequentHours)) return { error: 'Pick how often.' }
  if (!(dailyHour >= 0 && dailyHour <= 23)) return { error: 'Pick the hour for the daily backup.' }
  if (![frequentKeep, dailyKeep].every(days)) return { error: 'Keep periods are 1 to 3650 days.' }
  updateClub(club.id, {
    backupFrequentHours: frequentHours, backupFrequentKeepDays: frequentKeep,
    backupDaily: form.get('daily') === 'on', backupDailyHour: dailyHour, backupDailyKeepDays: dailyKeep,
  })
  reapplyKeep(getClub(club.id)!)
  revalidatePath(`/admin/clubs/${club.id}`)
  return { ok: 'Saved. Existing backups now follow the new keep periods.' }
}

export async function restoreAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const club = getClub(Number(str(form, 'id')))
  const backup = getBackup(Number(str(form, 'backupId')))
  if (!club) return { error: 'That site no longer exists.' }
  if (!backup || backup.status !== 'ready' || backup.clubId !== club.id) return { error: 'That backup is not available.' }
  if (club.status !== 'running' && club.status !== 'paused') return { error: 'Only a running or paused site can be restored.' }
  if (str(form, 'confirm') !== club.name) return { error: `Type ${club.name} to confirm.` }
  if (hasPendingOperation(club.id)) return { error: 'Wait for the current change to finish first.' }
  const err = codeError(admin.id, str(form, 'code'))
  if (err) return { error: err }
  enqueue(club, 'restore', admin.email, { backupId: backup.id })
  await audit(admin, 'restore', { club, detail: `Backup of ${backup.startedAt}` })
  redirect(`/admin/clubs/${club.id}`)
}

/** A new site made from a backup, at its own address, for checking something without touching the live site. */
export async function restoreCopyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const backup = getBackup(Number(str(form, 'backupId')))
  if (!backup || backup.status !== 'ready') return { error: 'That backup is not available.' }
  const name = str(form, 'name').toLowerCase()
  const nameErr = newNameError(name)
  if (nameErr) return { error: `Web address: ${nameErr}` }
  const err = codeError(admin.id, str(form, 'code'))
  if (err) return { error: err }
  let manifest
  try { manifest = await readManifest(backup) } catch (e) { return { error: `Couldn't read the backup: ${(e as Error).message}` } }
  const store = backupStore()!
  let saved: SavedSettings['deployer'] | null = null
  try {
    const { decryptBuffer } = await import('@/lib/backups/crypt')
    const parts: Buffer[] = []
    for await (const c of await store.get(manifest.settings.key)) parts.push(Buffer.from(c))
    saved = (JSON.parse((await decryptBuffer(backupKey(), Buffer.concat(parts))).toString('utf8')) as SavedSettings).deployer
  } catch { /* fall back to the source site's current settings */ }
  const source = backup.clubId ? getClub(backup.clubId) : null
  const from = saved ?? source
  // A database's copy is a new database in the same project (it can't have a web address).
  if (source?.kind === 'postgres') {
    const batch = newBatch()
    const project = getProject(source.projectId)
    if (!project) return { error: "The database's project is gone." }
    const made = createDatabase(project, { name, displayName: `${source.displayName} (copy)`, version: pgVersionOf(manifest.image) || undefined, memoryMb: source.memoryMb, quotaMb: source.pgQuotaMb }, admin.email, batch)
    if ('error' in made) return { error: made.error }
    updateClub(made.club.id, { notes: `Copy of ${backup.clubName} from the backup of ${backup.startedAt.slice(0, 16).replace('T', ' ')} UTC (${backup.ref}).`, backupFrequentHours: 0, backupDaily: false })
    enqueue(made.club, 'restore', admin.email, { backupId: backup.id, copy: true }, batch)
    await audit(admin, 'restore-copy', { club: made.club, detail: `From backup ${backup.id}` })
    redirect(`/admin/clubs/${made.club.id}`)
  }
  // A storage's copy is a new storage in the same project, inside it only, with the same buckets.
  if (source?.kind === 'minio') {
    const batch = newBatch()
    const project = getProject(source.projectId)
    if (!project) return { error: "The storage's project is gone." }
    const made = createStorage(project, { name, displayName: `${source.displayName} (copy)`, bucket: source.s3Buckets[0]?.name, memoryMb: source.memoryMb, quotaMb: source.pgQuotaMb }, admin.email, batch)
    if ('error' in made) return { error: made.error }
    updateClub(made.club.id, {
      s3Buckets: source.s3Buckets.map((b) => ({ name: b.name, public: false, objects: null, bytes: null })),
      notes: `Copy of ${backup.clubName} from the backup of ${backup.startedAt.slice(0, 16).replace('T', ' ')} UTC (${backup.ref}).`, backupFrequentHours: 0, backupDaily: false,
    })
    enqueue(getClub(made.club.id)!, 'restore', admin.email, { backupId: backup.id, copy: true }, batch)
    await audit(admin, 'restore-copy', { club: made.club, detail: `From backup ${backup.id}` })
    redirect(`/admin/clubs/${made.club.id}`)
  }
  const server = (source && getServer(source.serverId)?.accepts_new ? getServer(source.serverId) : null) ?? pickServer()
  if (!server) return { error: 'No server can take a new site. Under Servers, tick "Takes new sites" on one, or raise its site limit.' }
  const platform = getSettings()
  // No payment keys and no search engines: a copy must never charge cards or show up in Google.
  const extraEnv = [(from?.extraEnv ?? '').split('\n').filter((l) => !/^SEO_INDEXING=/.test(l)).join('\n').trim(), 'SEO_INDEXING=off'].filter(Boolean).join('\n')
  const copy = insertClub({
    name, displayName: `${from?.displayName ?? backup.clubName} (copy)`, serverId: server.id, status: 'creating', image: manifest.image,
    modules: from?.modules ?? [], customDomains: [], secrets: {}, extraEnv, timezone: from?.timezone || platform.defaultTimezone,
    memoryMb: from?.memoryMb ?? platform.defaultMemoryMb, ownerEmail: from?.ownerEmail ?? admin.email, ownerName: from?.ownerName ?? '',
    notes: `Copy of ${backup.clubName} from the backup of ${backup.startedAt.slice(0, 16).replace('T', ' ')} UTC (${backup.ref}). Background jobs are paused in it.`,
    pinned: true, backupFrequentHours: 0, backupDaily: false,
  })
  // The first admin only closes the open sign-up form until the backup's own users replace it.
  // One batch: if the create fails, the restore is not run.
  const batch = newBatch()
  enqueue(copy, 'create', admin.email, { adminEmail: admin.email, adminPassword: randomPassword(20) }, batch)
  enqueue(copy, 'restore', admin.email, { backupId: backup.id, copy: true }, batch)
  await audit(admin, 'restore-copy', { club: copy, detail: `From backup ${backup.id}` })
  redirect(`/admin/clubs/${copy.id}`)
}

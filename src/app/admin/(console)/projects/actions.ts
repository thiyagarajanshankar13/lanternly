'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit'
import { projectFor, requireOwner, siteFor } from '@/lib/guards'
import { getClub, getServer, listClubs, serverRoomError, updateClub } from '@/lib/clubs'
import { enqueue, hasPendingOperation, syncProjectNetworks } from '@/lib/ops'
import {
  PG_VERSIONS, createProjectRow, deleteProject, getProject, getProjectByName, linksOfApp, pgImage, pgVersionOf, updateProject,
} from '@/lib/projects'
import { appsUsing } from '@/lib/services'
import { createDatabase, databaseCredentials, settingsError } from '@/lib/postgres/service'
import { clubNameError } from '@/lib/validate'

type FormState = { error?: string; ok?: string } | undefined

const str = (form: FormData, key: string) => String(form.get(key) ?? '').trim()

// ── Projects ─────────────────────────────────────────────────────────────────

export async function createProjectAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const displayName = str(form, 'displayName')
  const name = (str(form, 'name') || displayName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28).replace(/-+$/, '')
  if (!displayName) return { error: 'Give the project a name.' }
  const nameErr = clubNameError(name)
  if (nameErr) return { error: `Short name: ${nameErr}` }
  if (getProjectByName(name)) return { error: `There is already a project called ${name}. Pick another short name.` }
  const server = getServer(Number(str(form, 'serverId')))
  if (!server) return { error: 'Pick the server its services run on.' }
  const id = createProjectRow({ name, displayName, serverId: server.id, description: str(form, 'description'), createdBy: admin.email })
  await audit(admin, 'project', { detail: `Created project ${displayName} (${name}) on ${server.name}` })
  redirect(`/admin/projects/${id}`)
}

export async function updateProjectAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const project = getProject(Number(str(form, 'id')))
  if (!project) return { error: 'That project no longer exists.' }
  const displayName = str(form, 'displayName')
  if (!displayName) return { error: 'Give the project a name.' }
  updateProject(project.id, { displayName, description: str(form, 'description') })
  await audit(admin, 'project', { detail: `Renamed or described project ${project.name}` })
  revalidatePath(`/admin/projects/${project.id}`)
  return { ok: 'Saved.' }
}

export async function deleteProjectAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const project = getProject(Number(str(form, 'id')))
  if (!project) return { error: 'That project no longer exists.' }
  if (str(form, 'confirm') !== project.name) return { error: `Type ${project.name} to confirm.` }
  const err = deleteProject(project.id)
  if (err) return { error: err }
  await audit(admin, 'project', { detail: `Removed project ${project.name}` })
  redirect('/admin/projects')
}

/** Moves a site, app or database to another project on the same server (a network swap, no restart). */
export async function moveServiceAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const club = getClub(Number(str(form, 'id')))
  if (!club) return { error: 'That service no longer exists.' }
  const target = getProject(Number(str(form, 'projectId')))
  if (!target) return { error: 'Pick the project to move it to.' }
  if (target.id === club.projectId) return { error: 'It is already in that project.' }
  if (target.serverId !== club.serverId) return { error: 'Services can only move to a project on the same server.' }
  if (hasPendingOperation(club.id)) return { error: 'Wait for the current change to finish first.' }
  if (club.status !== 'running' && club.status !== 'paused') return { error: "It can't be moved in its current state." }
  // Links only work inside a project, so they have to go first.
  if (club.kind === 'postgres' && appsUsing(club.id).length) return { error: `${appsUsing(club.id).map((a) => a.displayName).join(', ')} still use this database. Disconnect them first, or move them together by removing the links, moving, and connecting again.` }
  if (club.kind === 'app' && (linksOfApp(club.id).length || /\$\{\{/.test(club.extraEnv))) return { error: "This app is connected to databases in its project. Remove those connections (and any ${{…}} references) from its settings first." }
  const from = getProject(club.projectId)
  updateClub(club.id, { projectId: target.id, projectSynced: 0 })
  enqueue(getClub(club.id)!, 'project', admin.email)
  await audit(admin, 'project', { club, detail: `Moved ${club.name} from ${from?.name ?? '–'} to ${target.name}` })
  revalidatePath(`/admin/clubs/${club.id}`)
  return { ok: `Moving ${club.displayName} to ${target.displayName}. It stays up while its network changes.` }
}

/** For servers whose clubctl was too old: try putting every service on its project network again. */
export async function connectServicesAction(_prev: FormState): Promise<FormState> {
  const admin = await requireOwner()
  for (const c of listClubs()) if (c.projectSynced === 2) updateClub(c.id, { projectSynced: 0 })
  const n = syncProjectNetworks(admin.email)
  revalidatePath('/admin/projects')
  return { ok: n ? `Connecting ${n} service${n === 1 ? '' : 's'} to their project networks.` : 'Every service is already on its project network.' }
}

// ── Databases ────────────────────────────────────────────────────────────────

export async function createDatabaseAction(_prev: FormState, form: FormData): Promise<FormState> {
  const found = await projectFor(Number(str(form, 'projectId')), 'build')
  if (!found) return { error: 'That project no longer exists.' }
  const { admin, project } = found
  const made = createDatabase(project, {
    name: str(form, 'name').toLowerCase(), displayName: str(form, 'displayName'), version: str(form, 'version') || undefined,
    memoryMb: Number(str(form, 'memoryMb')) || undefined, quotaMb: Math.round(Number(str(form, 'quotaGb')) * 1024) || undefined,
  }, admin.email)
  if ('error' in made) return { error: made.error }
  redirect(`/admin/clubs/${made.club.id}`)
}

export async function updateDatabaseAction(_prev: FormState, form: FormData): Promise<FormState> {
  const found = await siteFor(Number(str(form, 'id')), 'operate')
  if (!found || found.club.kind !== 'postgres') return { error: 'That database no longer exists.' }
  const { admin, club } = found
  if (hasPendingOperation(club.id)) return { error: 'Wait for the current change to finish first.' }
  if (club.status !== 'running' && club.status !== 'paused') return { error: "This database can't be changed in its current state." }
  const displayName = str(form, 'displayName') || club.name
  const memoryMb = Number(str(form, 'memoryMb')) || club.memoryMb
  const quotaMb = Math.round(Number(str(form, 'quotaGb')) * 1024) || club.pgQuotaMb
  const err = settingsError(memoryMb, quotaMb)
  if (err) return { error: err }
  if (memoryMb > club.memoryMb) {
    const server = getServer(club.serverId)
    const room = server ? serverRoomError(server, { memoryMb: memoryMb - club.memoryMb, site: false }) : null
    if (room) return { error: room }
  }
  updateClub(club.id, { displayName, memoryMb, pgQuotaMb: quotaMb, notes: String(form.get('notes') ?? '') })
  const restart = memoryMb !== club.memoryMb
  if (restart) enqueue(getClub(club.id)!, 'configure', admin.email)
  revalidatePath(`/admin/clubs/${club.id}`)
  return { ok: restart ? 'Saved. The database restarts with the new memory (a few seconds; apps reconnect).' : 'Saved. A new quota counts within 5 minutes.' }
}

/** Shows the real connection values (password included) once, and logs that it was shown. */
export async function revealDatabaseAction(_prev: FormState, form: FormData): Promise<FormState> {
  const found = await siteFor(Number(str(form, 'id')), 'operate')
  if (!found || found.club.kind !== 'postgres') return { error: 'That database no longer exists.' }
  const { admin, club } = found
  if (club.status !== 'running' && club.status !== 'paused') return { error: "The database isn't ready yet." }
  const res = await databaseCredentials(club)
  if ('error' in res) return { error: res.error }
  await audit(admin, 'db-credentials-shown', { club })
  return { ok: res.lines.join('\n') }
}

export async function rotateDatabaseAction(_prev: FormState, form: FormData): Promise<FormState> {
  const found = await siteFor(Number(str(form, 'id')), 'operate')
  if (!found || found.club.kind !== 'postgres') return { error: 'That database no longer exists.' }
  const { admin, club } = found
  if (hasPendingOperation(club.id)) return { error: 'Wait for the current change to finish first.' }
  if (club.status !== 'running') return { error: 'Resume the database first.' }
  enqueue(club, 'rotate', admin.email)
  revalidatePath(`/admin/clubs/${club.id}`)
  const users = appsUsing(club.id)
  return { ok: `Making a new password.${users.length ? ` ${users.map((a) => a.displayName).join(', ')} restart${users.length === 1 ? 's' : ''} to use it.` : ''}` }
}

export async function upgradeDatabaseAction(_prev: FormState, form: FormData): Promise<FormState> {
  const found = await siteFor(Number(str(form, 'id')), 'operate')
  if (!found || found.club.kind !== 'postgres') return { error: 'That database no longer exists.' }
  const { admin, club } = found
  const version = str(form, 'version')
  if (!(PG_VERSIONS as readonly string[]).includes(version)) return { error: `Pick PostgreSQL ${PG_VERSIONS.join(' or ')}.` }
  if (version === pgVersionOf(club.image)) return { error: `It already runs PostgreSQL ${version}.` }
  if (Number(version) < Number(pgVersionOf(club.image))) return { error: 'PostgreSQL only moves to newer versions. Restore an older backup into a new database instead.' }
  if (hasPendingOperation(club.id)) return { error: 'Wait for the current change to finish first.' }
  if (club.status !== 'running') return { error: 'Resume the database first: its data is copied while it runs.' }
  enqueue(club, 'upgrade', admin.email, { image: pgImage(version) })
  revalidatePath(`/admin/clubs/${club.id}`)
  return { ok: `Moving to PostgreSQL ${version}. Apps can't reach it for the minute or so this takes.` }
}

/** A database whose create failed: try again (owners, or operators of its project). */
export async function retryDatabaseAction(form: FormData) {
  const found = await siteFor(Number(str(form, 'id')), 'operate')
  if (!found || found.club.kind !== 'postgres' || found.club.status !== 'failed' || hasPendingOperation(found.club.id)) return
  updateClub(found.club.id, { status: 'creating' })
  enqueue(getClub(found.club.id)!, 'create', found.admin.email)
  revalidatePath(`/admin/clubs/${found.club.id}`)
}


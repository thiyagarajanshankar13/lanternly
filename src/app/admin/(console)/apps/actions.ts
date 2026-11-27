'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { isOwner } from '@/lib/access'
import { audit } from '@/lib/audit'
import { projectFor, requireOwner, siteFor } from '@/lib/guards'
import { getClub, getClubByName, getServer, newNameError, insertClub, isApp, isImageApp, pickServer, serverRoomError, updateClub, type Club } from '@/lib/clubs'
import { createProjectRow, freeProjectName, getProject, linksClash, predeployError, prefixError, refsError, setLinks, type Project } from '@/lib/projects'
import { databasesIn } from '@/lib/services'
import { PG_DEFAULT_MEMORY_MB, createDatabase, databaseError } from '@/lib/postgres/service'
import { enqueue, hasPendingOperation } from '@/lib/ops'
import { getSettings, saveSettings } from '@/lib/settings'
import { NO_BASE_DOMAIN, clubNameError, isImage } from '@/lib/validate'
import {
  APP_MEMORY_MAX, APP_MEMORY_MIN, branchError, dockerfileError, healthPathError, mergeSecretEnv, parseEnvLines, portError, repoError,
} from '@/lib/apps/config'
import { activeBuild, startBuild } from '@/lib/apps/builds'
import { parseImageRef, registryUserError } from '@/lib/apps/imageRef'
import { github, githubConfigured, githubOwnerName } from '@/lib/apps/github'
import {
  BUILD_SECRET_ID, BUILD_SECRET_KEY, buildRepoError, discardPendingApp, ownerError, pendingApp, prepareManifest, saveBuildSecrets,
} from '@/lib/apps/githubSetup'
import { isFakeEngine } from '@/lib/engine'

type FormState = { error?: string; ok?: string } | undefined

const str = (form: FormData, key: string) => String(form.get(key) ?? '').trim()

/** The app fields shared by "New app" and its settings. */
function appFieldsFrom(form: FormData, memoryFallback: number, opts: { healthOptional?: boolean } = {}) {
  const port = Number(str(form, 'appPort') || '3000')
  // Images such as Redis answer no web page, so for them an empty health page means "running is enough".
  const healthPath = str(form, 'appHealthPath') || (opts.healthOptional ? '' : '/')
  const dockerfile = str(form, 'appDockerfile') || 'Dockerfile'
  const memoryMb = Number(str(form, 'memoryMb')) || memoryFallback
  const error = portError(port) ?? healthPathError(healthPath) ?? dockerfileError(dockerfile)
    ?? (memoryMb >= APP_MEMORY_MIN && memoryMb <= APP_MEMORY_MAX ? null : `Memory must be between ${APP_MEMORY_MIN} and ${APP_MEMORY_MAX} MB.`)
  return { port, healthPath, dockerfile, memoryMb, autoDeploy: form.get('appAutoDeploy') === 'on', error }
}

/** The databases ticked in the form (with their prefixes) and the pre-deploy command, checked against the project. */
function servicesFrom(form: FormData, projectDbs: Pick<Club, 'id' | 'name'>[], extraEnv: string, newDbName = '') {
  const ids = new Set(projectDbs.map((d) => d.id))
  const links = form.getAll('db').map((v) => Number(v)).filter((id) => ids.has(id)).map((dbId) => ({ dbId, prefix: str(form, `prefix-${dbId}`).toUpperCase() }))
  const predeploy = str(form, 'appPredeploy')
  const names = [...projectDbs.map((d) => d.name), ...(newDbName ? [newDbName] : [])]
  const error = links.map((l) => prefixError(l.prefix)).find(Boolean)
    ?? linksClash([...links, ...(newDbName ? [{ prefix: '' }] : [])])
    ?? refsError(extraEnv, names)
    ?? predeployError(predeploy)
  return { links, predeploy, error: error ?? null }
}

export async function createAppAction(_prev: FormState, form: FormData): Promise<FormState> {
  // Owners create apps anywhere; operators of a project can add one to it.
  const projectId = Number(str(form, 'projectId')) || 0
  const inProject = projectId ? await projectFor(projectId, 'build') : null
  if (projectId && !inProject) return { error: 'That project no longer exists.' }
  const admin = inProject ? inProject.admin : await requireOwner()
  let project: Project | null = inProject?.project ?? null
  const platform = getSettings()
  if (!githubConfigured()) return { error: 'Set up the GitHub App under Settings first.' }
  if (!platform.baseDomain) return { error: NO_BASE_DOMAIN }
  const name = str(form, 'name').toLowerCase()
  const displayName = str(form, 'displayName')
  const repo = str(form, 'appRepo')
  const branch = str(form, 'appBranch')
  const nameErr = newNameError(name)
  if (nameErr) return { error: `Web address: ${nameErr}` }
  if (!displayName) return { error: 'Give the app a name.' }
  const repoErr = repoError(repo, githubOwnerName()) ?? branchError(branch)
  if (repoErr) return { error: repoErr }
  const f = appFieldsFrom(form, platform.appDefaultMemoryMb)
  if (f.error) return { error: f.error }
  const extraEnv = String(form.get('extraEnv') ?? '')
  const plain = parseEnvLines(extraEnv)
  if (plain.error) return { error: `Settings: ${plain.error}` }
  const secret = mergeSecretEnv({}, String(form.get('secretEnv') ?? ''))
  if (secret.error) return { error: `Secret settings: ${secret.error}` }
  const newDbName = form.get('newDb') === 'on' ? `${name.slice(0, 28)}-db` : ''
  if (newDbName) {
    const dbErr = databaseError({ name: newDbName })
    if (dbErr) return { error: `The new database: ${dbErr}` }
  }
  const svc = servicesFrom(form, project ? databasesIn(project.id) : [], extraEnv, newDbName)
  if (svc.error) return { error: svc.error }

  // The branch has to exist before anything is created.
  try { await github().branchHead(repo, branch) } catch (err) { return { error: (err as Error).message } }

  const serverId = Number(str(form, 'serverId'))
  const server = project ? getServer(project.serverId) : serverId ? getServer(serverId) : pickServer({ forApps: true })
  if (!server) return { error: 'No server can take a new site. Under Servers, tick "Takes new sites" on one, raise its site limit, or add a server.' }
  const room = serverRoomError(server, { memoryMb: f.memoryMb + (newDbName ? PG_DEFAULT_MEMORY_MB : 0), site: true })
  if (room) return { error: room }

  // A new database needs the project before the app exists, so make the app's project now.
  if (!project && newDbName) {
    project = getProject(createProjectRow({ name: freeProjectName(name), displayName, serverId: server.id, createdBy: admin.email }))
  }
  const links = [...svc.links]
  if (newDbName && project) {
    const made = createDatabase(project, { name: newDbName, displayName: `${displayName} database` }, admin.email)
    if ('error' in made) return { error: `The new database: ${made.error}` }
    links.push({ dbId: made.club.id, prefix: '' })
  }

  const club = insertClub({
    name, displayName, serverId: server.id, status: 'creating', image: '', modules: [], customDomains: [], secrets: { appSecretEnv: secret.env },
    extraEnv, timezone: platform.defaultTimezone, memoryMb: f.memoryMb, ownerEmail: '', ownerName: '', notes: str(form, 'notes'),
    kind: 'app', appRepo: repo, appBranch: branch, appDockerfile: f.dockerfile, appPort: f.port, appHealthPath: f.healthPath, appAutoDeploy: f.autoDeploy,
    appPredeploy: svc.predeploy, projectId: project?.id, createdBy: admin.email,
  })
  if (links.length) setLinks(club.id, links)
  try {
    await startBuild(club, { by: admin.email, reason: 'create' })
  } catch (err) {
    updateClub(club.id, { status: 'failed' })
    console.error('[apps] first build:', (err as Error).message)
  }
  redirect(`/admin/clubs/${club.id}`)
}

/** The private-image sign-in typed in a form: both or neither; an empty token keeps the saved one. */
function registryFrom(form: FormData, saved: { registryUser?: string; registryToken?: string } = {}) {
  const user = str(form, 'registryUser')
  const token = str(form, 'registryToken')
  if (!user) return { registryUser: undefined, registryToken: undefined, error: null }
  const error = registryUserError(user) ?? (!token && !saved.registryToken ? 'Add the access token for that user name (or clear the user name for a public image).' : null)
  return { registryUser: user, registryToken: token || saved.registryToken, error }
}

/** A service from a ready-made image (Docker Hub or another registry): no GitHub, no build. */
export async function createImageAppAction(_prev: FormState, form: FormData): Promise<FormState> {
  const projectId = Number(str(form, 'projectId')) || 0
  const inProject = projectId ? await projectFor(projectId, 'build') : null
  if (projectId && !inProject) return { error: 'That project no longer exists.' }
  const admin = inProject ? inProject.admin : await requireOwner()
  let project: Project | null = inProject?.project ?? null
  const platform = getSettings()
  const name = str(form, 'name').toLowerCase()
  const displayName = str(form, 'displayName')
  const nameErr = newNameError(name)
  if (nameErr) return { error: `Name: ${nameErr}` }
  if (!displayName) return { error: 'Give the service a name.' }
  const parsed = parseImageRef(str(form, 'imageRef'))
  if ('error' in parsed) return { error: `Image: ${parsed.error}` }
  const reg = registryFrom(form)
  if (reg.error) return { error: reg.error }
  const appPublic = form.get('appPublic') === 'on'
  if (appPublic && !platform.baseDomain) return { error: NO_BASE_DOMAIN }
  const f = appFieldsFrom(form, platform.appDefaultMemoryMb, { healthOptional: true })
  if (f.error) return { error: f.error }
  const extraEnv = String(form.get('extraEnv') ?? '')
  const plain = parseEnvLines(extraEnv)
  if (plain.error) return { error: `Settings: ${plain.error}` }
  const secret = mergeSecretEnv({}, String(form.get('secretEnv') ?? ''))
  if (secret.error) return { error: `Secret settings: ${secret.error}` }
  const svc = servicesFrom(form, project ? databasesIn(project.id) : [], extraEnv)
  if (svc.error) return { error: svc.error }

  const serverId = Number(str(form, 'serverId'))
  const server = project ? getServer(project.serverId) : serverId ? getServer(serverId) : pickServer({ forApps: true })
  if (!server) return { error: 'No server can take a new site. Under Servers, tick "Takes new sites" on one, raise its site limit, or add a server.' }
  const room = serverRoomError(server, { memoryMb: f.memoryMb, site: true })
  if (room) return { error: room }

  const club = insertClub({
    name, displayName, serverId: server.id, status: 'creating', image: parsed.ref, modules: [], customDomains: [],
    secrets: { appSecretEnv: secret.env, ...(reg.registryUser ? { registryUser: reg.registryUser, registryToken: reg.registryToken } : {}) },
    extraEnv, timezone: platform.defaultTimezone, memoryMb: f.memoryMb, ownerEmail: '', ownerName: '', notes: str(form, 'notes'),
    kind: 'app', appRepo: '', appBranch: '', appDockerfile: '', appPort: f.port, appHealthPath: f.healthPath, appAutoDeploy: false,
    appPredeploy: svc.predeploy, appImageRef: parsed.ref, appPublic, projectId: project?.id, createdBy: admin.email,
  })
  if (svc.links.length) setLinks(club.id, svc.links)
  enqueue(club, 'create', admin.email, { image: parsed.ref })
  await audit(admin, 'project', { club, detail: `Added ${parsed.display} as ${name}${project ? ` in ${project.name}` : ''}` })
  redirect(`/admin/clubs/${club.id}`)
}

export async function updateAppAction(_prev: FormState, form: FormData): Promise<FormState> {
  const found = await siteFor(Number(str(form, 'id')), 'operate')
  if (!found || !isApp(found.club)) return { error: 'That app no longer exists.' }
  const { admin, club } = found
  if (hasPendingOperation(club.id)) return { error: 'Wait for the current change to finish first.' }
  // A failed create can have its settings fixed; nothing runs until "Build and try again".
  const failed = club.status === 'failed'
  if (club.status !== 'running' && club.status !== 'paused' && !failed) return { error: "This app can't be changed in its current state." }
  if (failed && activeBuild(club.id)) return { error: 'Wait for the current build to finish first.' }
  const displayName = str(form, 'displayName')
  if (!displayName) return { error: 'Give the app a name.' }
  const imageApp = isImageApp(club)
  const branch = imageApp ? '' : str(form, 'appBranch') || club.appBranch
  const bErr = imageApp ? null : branchError(branch)
  if (bErr) return { error: bErr }
  let imageRef = club.appImageRef
  let reg: { registryUser?: string; registryToken?: string } = {}
  if (imageApp) {
    const parsed = parseImageRef(str(form, 'imageRef') || club.appImageRef)
    if ('error' in parsed) return { error: `Image: ${parsed.error}` }
    imageRef = parsed.ref
    const r = registryFrom(form, club.secrets)
    if (r.error) return { error: r.error }
    reg = { registryUser: r.registryUser, registryToken: r.registryToken }
  }
  const appPublic = imageApp ? form.get('appPublic') === 'on' : club.appPublic
  const f = appFieldsFrom(form, club.memoryMb, { healthOptional: imageApp })
  if (f.error) return { error: f.error }
  const extraEnv = String(form.get('extraEnv') ?? '')
  const plain = parseEnvLines(extraEnv)
  if (plain.error) return { error: `Settings: ${plain.error}` }
  const secret = mergeSecretEnv(club.secrets.appSecretEnv ?? {}, String(form.get('secretEnv') ?? ''))
  if (secret.error) return { error: `Secret settings: ${secret.error}` }
  const svc = servicesFrom(form, databasesIn(club.projectId), extraEnv)
  if (svc.error) return { error: svc.error }
  if (f.memoryMb > club.memoryMb) {
    const server = getServer(club.serverId)
    const room = server ? serverRoomError(server, { memoryMb: f.memoryMb - club.memoryMb, site: false }) : null
    if (room) return { error: room }
  }
  const branchChanged = !imageApp && branch !== club.appBranch
  if (branchChanged) {
    try { await github().branchHead(club.appRepo, branch) } catch (err) { return { error: (err as Error).message } }
  }

  const secrets = { ...club.secrets, appSecretEnv: secret.env }
  if (imageApp) { secrets.registryUser = reg.registryUser; secrets.registryToken = reg.registryToken }
  updateClub(club.id, {
    displayName, appPort: f.port, appHealthPath: f.healthPath, memoryMb: f.memoryMb, extraEnv, secrets, notes: String(form.get('notes') ?? ''), appPredeploy: svc.predeploy,
    ...(imageApp ? { appImageRef: imageRef, appPublic } : { appBranch: branch, appDockerfile: f.dockerfile, appAutoDeploy: f.autoDeploy }),
  })
  setLinks(club.id, svc.links)
  const fresh = getClub(club.id)!
  if (failed) {
    revalidatePath(`/admin/clubs/${club.id}`)
    return { ok: 'Saved. Press Build and try again to use the new settings.' }
  }
  let extra = ''
  if (imageApp && imageRef !== club.appImageRef) {
    // A new image: pull and deploy it (the settings go along with it).
    enqueue(fresh, 'deploy', admin.email, { image: imageRef })
    extra = ' Pulling the new image now.'
  } else enqueue(fresh, 'configure', admin.email)
  if (!imageApp && (branchChanged || f.dockerfile !== club.appDockerfile)) {
    try { await startBuild(fresh, { by: admin.email, reason: 'deploy' }); extra = ` Building ${branch} now; it is deployed when the build finishes.` }
    catch (err) { extra = ` The build couldn't start: ${(err as Error).message}` }
  }
  revalidatePath(`/admin/clubs/${club.id}`)
  return { ok: `Saved. The app restarts to apply it (a few seconds).${extra}` }
}

/** Deploy latest, roll back to an earlier version, or try a failed create again. */
export async function appDeployAction(form: FormData) {
  const found = await siteFor(Number(str(form, 'id')), 'operate')
  if (!found || !isApp(found.club)) return
  const { admin, club } = found
  const kind = str(form, 'kind')
  if (kind === 'retry-create' && !isOwner(admin)) return
  if (hasPendingOperation(club.id) || activeBuild(club.id)) return
  if (isImageApp(club)) {
    // Pull the image's tag again (a newer build of it, if there is one); no GitHub involved.
    if (kind === 'latest' && (club.status === 'running' || club.status === 'paused')) enqueue(club, 'deploy', admin.email, { image: club.appImageRef })
    else if (kind === 'rollback' && (club.status === 'running' || club.status === 'paused')) {
      const image = str(form, 'image')
      if (image && isImage(image) && image !== club.image) enqueue(club, 'deploy', admin.email, { image })
    } else if (kind === 'retry-create' && club.status === 'failed') {
      updateClub(club.id, { status: 'creating' })
      enqueue(getClub(club.id)!, 'create', admin.email, { image: club.appImageRef })
    }
    revalidatePath(`/admin/clubs/${club.id}`)
    return
  }
  try {
    if (kind === 'latest' && (club.status === 'running' || club.status === 'paused')) {
      await startBuild(club, { by: admin.email, reason: 'deploy' })
    } else if (kind === 'rollback' && (club.status === 'running' || club.status === 'paused')) {
      const image = str(form, 'image')
      if (image && isImage(image) && image !== club.image) enqueue(club, 'deploy', admin.email, { image })
    } else if (kind === 'retry-create' && club.status === 'failed') {
      updateClub(club.id, { status: 'creating' })
      await startBuild(getClub(club.id)!, { by: admin.email, reason: 'create' })
    }
  } catch (err) {
    if (kind === 'retry-create') updateClub(club.id, { status: 'failed' })
    console.error('[apps] deploy:', (err as Error).message)
  }
  revalidatePath(`/admin/clubs/${club.id}`)
}

// ── Settings > GitHub ────────────────────────────────────────────────────────
export async function saveGithubSettingsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const appId = str(form, 'githubAppId')
  const owner = str(form, 'githubOwner')
  const buildRepo = str(form, 'githubBuildRepo')
  const key = String(form.get('githubPrivateKey') ?? '').trim()
  const secret = str(form, 'githubWebhookSecret')
  const memory = Number(str(form, 'appDefaultMemoryMb'))
  if (appId && !/^\d{1,12}$/.test(appId)) return { error: 'The App ID is a number (on the GitHub App\'s page, under About).' }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner)) return { error: 'Enter the GitHub organisation or user, like my-company.' }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(buildRepo)) return { error: 'Enter the deployer repo as owner/name.' }
  if (key && !/-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----/.test(key)) return { error: 'Paste the whole private key file, from -----BEGIN to -----END.' }
  if (secret && secret.length < 20) return { error: 'Make the webhook secret at least 20 characters.' }
  if (!(memory >= APP_MEMORY_MIN && memory <= APP_MEMORY_MAX)) return { error: `Memory must be between ${APP_MEMORY_MIN} and ${APP_MEMORY_MAX} MB.` }
  const changedApp = appId !== getSettings().githubAppId
  saveSettings({
    ...(changedApp ? { githubAppSlug: '', githubAppName: '', githubBuildSecretsFor: '' } : {}),
    githubAppId: appId, githubOwner: owner, githubBuildRepo: buildRepo, appDefaultMemoryMb: memory,
    ...(key ? { githubPrivateKey: key } : {}), ...(secret ? { githubWebhookSecret: secret } : {}),
  })
  await audit(admin, 'github', { detail: key || secret ? 'GitHub app settings (key or secret replaced)' : 'GitHub app settings' })
  revalidatePath('/admin/settings')
  return { ok: 'Saved. Press "Test GitHub" to check it.' }
}

export async function testGithubAction(_prev: FormState): Promise<FormState> {
  await requireOwner()
  if (!githubConfigured()) return { error: 'Add the App ID and private key first.' }
  try {
    const repos = await github().listRepos()
    if (!repos.length) return { error: `The GitHub App can't see any repos of ${getSettings().githubOwner}. Install it on the repos you want to deploy.` }
    const build = getSettings().githubBuildRepo.toLowerCase()
    const hasBuild = repos.some((r) => r.fullName.toLowerCase() === build)
    return hasBuild
      ? { ok: `Works. The GitHub App sees ${repos.length} repo${repos.length === 1 ? '' : 's'}, including ${getSettings().githubBuildRepo} (where builds run).` }
      : { error: `The GitHub App sees ${repos.length} repo${repos.length === 1 ? '' : 's'} but not ${getSettings().githubBuildRepo}, where builds run. Add that repo to the App's installation.` }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

// ── "Create GitHub app" (src/lib/apps/githubSetup.ts) ────────────────────────
/** Step 1 of the one-click setup: the manifest and where the browser posts it. */
export async function prepareGithubAppAction(input: { owner: string; buildRepo: string }): Promise<{ error: string } | { url: string; manifest: string }> {
  const admin = await requireOwner()
  const owner = String(input.owner ?? '').trim()
  const buildRepo = String(input.buildRepo ?? '').trim()
  const bad = ownerError(owner) ?? buildRepoError(buildRepo, owner)
  if (bad) return { error: bad }
  if (isFakeEngine()) return { error: 'Practice mode doesn\'t talk to GitHub, so it can\'t create a GitHub App.' }
  const out = await prepareManifest(owner, buildRepo)
  await audit(admin, 'github', { detail: `Started creating a GitHub App on ${owner}` })
  return out
}

export async function discardPendingGithubAppAction(_prev: FormState): Promise<FormState> {
  const admin = await requireOwner()
  const p = pendingApp()
  if (!p) return { ok: 'Nothing to discard.' }
  discardPendingApp()
  await audit(admin, 'github', { detail: `Discarded the uninstalled GitHub App ${p.name} (${p.id})` })
  revalidatePath('/admin/settings/github')
  return { ok: `Forgotten. Delete ${p.name} on GitHub too: ${p.htmlUrl}` }
}

export async function saveBuildSecretsAction(_prev: FormState): Promise<FormState> {
  const admin = await requireOwner()
  if (!githubConfigured()) return { error: 'Connect GitHub first.' }
  const r = await saveBuildSecrets()
  revalidatePath('/admin/settings/github')
  if (r.secrets === 'saved') { await audit(admin, 'github', { detail: 'Saved the build secrets in the build repo' }); return { ok: `Saved ${BUILD_SECRET_ID} and ${BUILD_SECRET_KEY} in ${getSettings().githubBuildRepo}.` } }
  if (r.secrets === 'no-permission') return { error: 'This GitHub App may not change secrets. Add them by hand (see the setup guide), or replace it with a new app.' }
  return { error: r.detail ?? 'GitHub said no.' }
}

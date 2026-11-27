import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { clubCount, getClub, insertClub, saveServer, updateClub, type Club } from '@/lib/clubs'
import { fakeCalls, fakeClubs, fakeFailures } from '@/lib/engine'
import { enqueue, getOperation, listOperations, whenIdle } from '@/lib/ops'
import { bucketNameError, getProject, linksClash, linksToDb, refsError, s3VarsShown, setLinks } from '@/lib/projects'
import { appsUsing, serviceLines, servicesOf, storageIn } from '@/lib/services'
import { bucketChangeError, checkStorage, createStorage, setStorageAlertSenderForTests, storageCredentials, storageError } from '@/lib/storage/service'
import { listBackups } from '@/lib/backups/records'
import { LocalStore, setBackupStoreForTests } from '@/lib/backups/store'
import { saveSettings } from '@/lib/settings'
import { freshEnv } from './setup'

let serverId = 0
const site = (name: string) => insertClub({
  name, displayName: name, serverId, status: 'running', image: 'img:1', modules: [], customDomains: [], secrets: {}, extraEnv: '',
  timezone: 'Australia/Sydney', memoryMb: 700, ownerEmail: 'o@example.com', ownerName: 'O', notes: '',
})
const app = (name: string, projectId: number, over: Partial<Club> = {}) => insertClub({
  name, displayName: name, serverId, status: 'running', image: 'ghcr.io/x/app:1', modules: [], customDomains: [], secrets: {}, extraEnv: '',
  timezone: 'Australia/Sydney', memoryMb: 256, ownerEmail: '', ownerName: '', notes: '', kind: 'app', appRepo: 'o/r', appBranch: 'main',
  appPort: 3000, appHealthPath: '/', projectId, ...over,
})
async function storage(project: string, over: Parameters<typeof createStorage>[1] | object = {}) {
  const holder = site(project)
  const made = createStorage(getProject(holder.projectId)!, { name: `${project}-files`, ...over }, 'a@x')
  if ('error' in made) throw new Error(made.error)
  await whenIdle()
  return { holder, club: getClub(made.club.id)!, projectId: holder.projectId! }
}

beforeEach(() => {
  const dir = freshEnv()
  fakeClubs().clear(); fakeFailures().clear(); fakeCalls().length = 0
  setBackupStoreForTests(new LocalStore(path.join(dir, 'bucket')))
  serverId = saveServer({ name: 'S1', host: '10.0.0.1', port: 22, username: 'deployer', hostKey: 'ssh-ed25519 AAAAtest', publicIp: '10.0.0.1', maxClubs: 5, acceptsNew: true })
  saveSettings({ baseDomain: 'avro.site', defaultImage: 'img:1' })
})

describe('storage rules', () => {
  it('checks names, buckets and sizes', () => {
    expect(storageError({ name: 'Bad Name' })).toMatch(/Name/)
    expect(storageError({ name: 'ok-files', bucket: 'A' })).toMatch(/First bucket/)
    expect(storageError({ name: 'ok-files', memoryMb: 64 })).toMatch(/Memory/)
    expect(storageError({ name: 'ok-files', quotaMb: 10 })).toMatch(/quota/)
    expect(storageError({ name: 'ok-files' })).toBeNull()
    expect(bucketNameError('uploads')).toBeNull()
    expect(bucketNameError('my.bucket')).toMatch(/lowercase/)
    expect(bucketNameError('a--b')).toMatch(/double/)
    expect(bucketNameError('sthree-abc')).toMatch(/reserved/)
  })

  it('shows the variables without the secret, and the AWS names only without a prefix', () => {
    const plain = s3VarsShown('shop-files', { bucket: 'files' })
    expect(plain.find((v) => v.key === 'S3_ENDPOINT')!.value).toBe('http://shop-files:9000')
    expect(plain.find((v) => v.key === 'S3_SECRET_ACCESS_KEY')!.value).not.toMatch(/[a-f0-9]{20}/)
    expect(plain.some((v) => v.key === 'AWS_*')).toBe(true)
    const pre = s3VarsShown('shop-files', { prefix: 'MEDIA_', publicUrl: 'https://shop-files.avro.site' })
    expect(pre.map((v) => v.key)).toContain('MEDIA_S3_PUBLIC_URL')
    expect(pre.find((v) => v.key === 'MEDIA_S3_PUBLIC_URL')!.value).toBe('https://shop-files.avro.site')
    expect(pre.some((v) => v.key === 'AWS_*')).toBe(false)
  })

  it('keeps database and storage prefixes apart, and knows storage references', () => {
    expect(linksClash([{ prefix: '' }, { prefix: '', storage: true }])).toBeNull()
    expect(linksClash([{ prefix: '', storage: true }, { prefix: '', storage: true }])).not.toBeNull()
    expect(refsError('X=${{shop-files.S3_ENDPOINT}}', [], ['shop-files'])).toBeNull()
    expect(refsError('X=${{nope.S3_ENDPOINT}}', [], ['shop-files'])).not.toBeNull()
  })
})

describe('storage services', () => {
  it('creates one in its project with its bucket, pinned to the pulled image, never counted as a site', async () => {
    const { club, projectId } = await storage('shop', { bucket: 'media', publicBucket: true })
    expect(club.status).toBe('running')
    const call = fakeCalls().find((x) => x.args[0] === 's3-create')!
    expect(call.args).toEqual(['s3-create', 'shop-files', 'docker.io/chainguard/minio:latest', '-'])
    expect(call.stdin).toContain('CLUBCTL_MEMORY_MB=256')
    expect(call.stdin).toContain('CLUBCTL_BUCKET=media:public')
    expect(call.stdin).toContain('CLUBCTL_PROJECT=shop')
    expect(club.image).toMatch(/^docker\.io\/chainguard\/minio@sha256:[a-f0-9]{64}$/)
    expect(club.s3Buckets.map((b) => b.name)).toEqual(['media'])
    expect(club.backupDaily).toBe(true)
    expect(clubCount(serverId)).toBe(1)
    expect(storageIn(projectId).map((c) => c.name)).toEqual(['shop-files'])
    expect(servicesOf(projectId).map((c) => c.kind)).toEqual(['avrosphere', 'minio'])
  })

  it('gives a web address only when asked', async () => {
    await storage('pub', { web: true })
    expect(fakeCalls().find((x) => x.args[0] === 's3-create')!.args[3]).toBe('pub-files.avro.site')
  })

  it('links apps to a bucket, and clubctl only gets storage of the same project', async () => {
    const { club, projectId } = await storage('shop', { bucket: 'media' })
    const other = await storage('other')
    const web = app('shop-web', projectId, { extraEnv: 'CDN=${{shop-files.S3_PUBLIC_URL}}' })
    setLinks(web.id, [{ dbId: club.id, prefix: '', bucket: 'media' }, { dbId: other.club.id, prefix: 'X_', bucket: 'files' }])
    const lines = serviceLines(getClub(web.id)!)
    expect(lines).toContain('CLUBCTL_S3_LINK=shop-files::media')
    expect(lines.some((l) => l.includes('other-files'))).toBe(false)
    expect(lines.some((l) => l.startsWith('CLUBCTL_LINK=shop-files'))).toBe(false) // never sent as a database
    // A bucket that isn't the storage's goes as "its first bucket".
    setLinks(web.id, [{ dbId: club.id, prefix: 'M_', bucket: 'gone' }])
    expect(serviceLines(getClub(web.id)!)).toContain('CLUBCTL_S3_LINK=shop-files:M_:')
    expect(appsUsing(club.id).map((a) => a.name)).toEqual(['shop-web'])
  })

  it('adds, changes and removes buckets; an app on a removed bucket moves to the first one and restarts', async () => {
    const { club, projectId } = await storage('shop')
    expect(bucketChangeError(club, 'files', true)).toMatch(/already/)
    expect(bucketChangeError(club, 'nope', false)).toMatch(/no bucket/)
    enqueue(club, 'buckets', 'a@x', { buckets: [{ name: 'files', public: false }, { name: 'avatars', public: true }] })
    await whenIdle()
    expect(getClub(club.id)!.s3Buckets.map((b) => `${b.name}:${b.public}`)).toEqual(['files:false', 'avatars:true'])
    expect(fakeClubs().get('shop-files')!.buckets!.get('avatars')).toBe(true)

    const web = app('shop-web', projectId)
    setLinks(web.id, [{ dbId: club.id, prefix: '', bucket: 'avatars' }])
    fakeClubs().get('shop-files')!.files!.set('avatars/a.png', Buffer.from('PNG'))
    const refused = enqueue(getClub(club.id)!, 'buckets', 'a@x', { removeBucket: 'avatars' }); await whenIdle()
    expect(getOperation(refused.id)!.status).toBe('failed') // still has files
    fakeClubs().get('shop-files')!.files!.delete('avatars/a.png')
    enqueue(getClub(club.id)!, 'buckets', 'a@x', { removeBucket: 'avatars' }); await whenIdle()
    expect(getClub(club.id)!.s3Buckets.map((b) => b.name)).toEqual(['files'])
    expect(linksToDb(club.id)[0].bucket).toBe('')
    expect(listOperations({ clubId: web.id })[0].kind).toBe('configure')
  })

  it('reveals the secret, makes a new one and restarts the apps using it', async () => {
    const { club, projectId } = await storage('shop')
    const shown = await storageCredentials(club)
    expect('lines' in shown && shown.lines.join('\n')).toContain('S3_SECRET_ACCESS_KEY=s3shopfiles0001')
    const web = app('shop-web', projectId)
    setLinks(web.id, [{ dbId: club.id, prefix: '', bucket: 'files' }])
    enqueue(getClub(club.id)!, 'rotate', 'a@x'); await whenIdle()
    expect(fakeCalls().some((x) => x.args[0] === 's3-rotate')).toBe(true)
    expect(listOperations({ clubId: web.id })[0].kind).toBe('configure')
  })

  it('keeps per-bucket numbers and emails at 80% and 100% without stopping writes', async () => {
    const sent: string[] = []
    setStorageAlertSenderForTests((subject) => { sent.push(subject) })
    const { club } = await storage('quota', { quotaMb: 1024 })
    const fake = fakeClubs().get('quota-files')!
    fake.files!.set('files/big.bin', Buffer.alloc(850 * 1024 * 1024))
    await checkStorage(getClub(club.id)!)
    expect(sent).toEqual(['Storage 80% full: quota-files'])
    expect(getClub(club.id)!.s3Buckets[0]).toMatchObject({ name: 'files', objects: 1, bytes: 850 * 1024 * 1024 })
    fake.files!.set('files/more.bin', Buffer.alloc(200 * 1024 * 1024))
    await checkStorage(getClub(club.id)!)
    await checkStorage(getClub(club.id)!)
    expect(sent).toEqual(['Storage 80% full: quota-files', 'Storage full: quota-files'])
    expect(fakeCalls().some((x) => x.args[0] === 'db-readonly')).toBe(false)
    setStorageAlertSenderForTests(undefined)
  })

  it('backs up its files and bucket list, and restores them', async () => {
    const { club } = await storage('shop')
    const fake = fakeClubs().get('shop-files')!
    fake.files!.set('files/a.jpg', Buffer.from('A'))
    enqueue(getClub(club.id)!, 'backup', 'a@x'); await whenIdle()
    const [b] = listBackups({ clubId: club.id })
    expect(b).toMatchObject({ status: 'ready', fileCount: 1 })
    fake.files!.set('files/b.jpg', Buffer.from('B'))
    fake.buckets!.set('extra', false)
    const op = enqueue(getClub(club.id)!, 'restore', 'a@x', { backupId: b.id }); await whenIdle()
    expect(getOperation(op.id)!.status).toBe('done')
    expect([...fake.files!.keys()]).toEqual(['files/a.jpg'])
    expect([...fake.buckets!.keys()]).toEqual(['files'])
  })

  it('refuses upgrades, and its create failure can be tried again', async () => {
    fakeFailures().add('s3-create')
    const holder = site('fail')
    const made = createStorage(getProject(holder.projectId)!, { name: 'fail-files' }, 'a@x')
    if ('error' in made) throw new Error(made.error)
    await whenIdle()
    expect(getClub(made.club.id)!.status).toBe('failed')
    updateClub(made.club.id, { status: 'creating' })
    enqueue(getClub(made.club.id)!, 'create', 'a@x'); await whenIdle()
    expect(getClub(made.club.id)!.status).toBe('running')
    const up = enqueue(getClub(made.club.id)!, 'upgrade', 'a@x', { image: 'x' }); await whenIdle()
    expect(getOperation(up.id)!.status).toBe('failed')
  })
})

import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { getServer, insertClub, listServers, pickServer, serverRoomError } from '@/lib/clubs'
import { saveSettings } from '@/lib/settings'
import { setRateFetcherForTests } from '@/plugins/aws/costs/service'
import { FakeLightsail, setLightsailForTests } from '@/plugins/aws/provision/lightsail'
import {
  budgetCheck, lightsailNameFor, limitError, parseDone, portRules, provisionPolicy, setupScript, sizeOptions, sq, userData,
} from '@/plugins/aws/provision/plan'
import {
  agentFiles, authorizeCallback, clearPriceCache, dailyCheck, discardJob, doneFrom, getJob, listSnapshots, missingSetup, progressFrom,
  retryJob, scriptFor, startCreate, startDelete, tickProvision, type ServerJob,
} from '@/plugins/aws/provision/jobs'
import { freshEnv } from './setup'

const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'

describe('plan', () => {
  it('offers the cheapest IPv4 Linux plan for each size, 1 GB included', async () => {
    const opts = sizeOptions(await new FakeLightsail().bundles())
    expect(opts.map((o) => o.ramGb)).toEqual([1, 2, 4, 8, 16])
    expect(opts[0].bundle.bundleId).toBe('micro_3_0')
    expect(opts[0].purpose).toBe('apps')
    expect(opts.find((o) => o.ramGb === 8)?.maxSites).toBe(10)
  })
  it('names VMs avro-<slug>', () => {
    expect(lightsailNameFor('Sydney 2')).toBe('avro-sydney-2')
    expect(lightsailNameFor('  Vote4MATES app!! ')).toBe('avro-vote4mates-app')
  })
  it('checks the budget in A$', () => {
    const c = budgetCheck({ currentUsd: 50, addUsd: 44, rate: 1.5, budget: 120, currency: 'AUD' })
    expect(c).toMatchObject({ nowCost: 75, addCost: 66, afterCost: 141, over: true })
    expect(budgetCheck({ currentUsd: 50, addUsd: 44, rate: 1.5, budget: 0, currency: 'AUD' }).over).toBe(false)
    expect(limitError(5, 5)).toMatch(/limit is 5/)
    expect(limitError(4, 5)).toBeNull()
  })
  it('opens 80/443 to all and SSH only to the deployer', () => {
    const rules = portRules('13.54.1.2')
    expect(rules.find((r) => r.fromPort === 22)).toMatchObject({ cidrs: ['13.54.1.2/32'], ipv6Cidrs: [], cidrListAliases: ['lightsail-connect'] })
    expect(rules.filter((r) => r.fromPort === 443).map((r) => r.protocol).sort()).toEqual(['tcp', 'udp'])
    expect(() => portRules('')).toThrow()
  })
  it('limits the AWS policy to tagged VMs in one region', () => {
    const p = JSON.parse(provisionPolicy('ap-southeast-2'))
    const del = p.Statement.find((s: { Action: string[] }) => s.Action.includes('lightsail:DeleteInstance'))
    expect(del.Condition.StringEquals['aws:ResourceTag/avro-managed']).toBe('yes')
    const create = p.Statement.find((s: { Action: string[] }) => s.Action.includes('lightsail:CreateInstances'))
    expect(create.Condition.StringEquals['aws:RequestTag/avro-managed']).toBe('yes')
  })
  it('writes a small launch script and a setup script that sends the host key back', () => {
    const u = userData({ deployerUrl: 'https://admin.avro.site/', jobId: 7, token: "t'k" })
    expect(u).toContain("'https://admin.avro.site/api/provision/7/script'")
    expect(u).toContain(sq("Authorization: Bearer t'k"))
    const script = setupScript({ deployerUrl: 'https://admin.avro.site', jobId: 7, token: 'tok', files: [{ path: 'clubctl', mode: 0o755, content: Buffer.from('#!/bin/bash\necho hi\n') }], deployerPublicKey: 'ssh-ed25519 AAAA', acmeEmail: 'a@b.co', ghcrUser: 'bot', ghcrToken: "x'y" })
    expect(script).toContain(Buffer.from('#!/bin/bash\necho hi\n').toString('base64'))
    expect(script).toContain('chmod 755')
    expect(script).toContain(`GHCR_TOKEN=${sq("x'y")}`)
    expect(script).toContain('ssh_host_ed25519_key.pub')
    expect(() => setupScript({ deployerUrl: 'x', jobId: 1, token: 't', files: [{ path: '../etc/passwd', mode: 0o644, content: Buffer.alloc(0) }], deployerPublicKey: '', acmeEmail: '', ghcrUser: '', ghcrToken: '' })).toThrow()
  })
  it('reads the VM\'s done message', () => {
    expect(parseDone(`ok\n${HOST_KEY}\n`)).toEqual({ ok: true, hostKey: HOST_KEY })
    expect(parseDone('ok\nnot a key')).toMatchObject({ ok: false })
    expect(parseDone('failed\n!! docker broke')).toMatchObject({ ok: false, error: expect.stringContaining('docker broke') })
  })
})

describe('making and deleting servers', () => {
  let ls: FakeLightsail
  beforeEach(() => {
    freshEnv()
    ls = new FakeLightsail()
    setLightsailForTests(ls)
    saveSettings({ costCurrency: 'AUD' })
    setRateFetcherForTests(async () => ({ rate: 1.5, date: '2026-11-24' }))
    clearPriceCache()
    process.env.DEPLOYER_URL = 'https://admin.avro.site'
    process.env.DEPLOYER_AGENT_DIR = path.resolve(__dirname, '../agent')
    saveSettings({ provisionAcmeEmail: 'ops@example.com', provisionGhcrUser: 'bot', provisionGhcrToken: 'ghp_secret', provisionDeployerIp: '192.0.2.10' })
  })
  afterEach(() => { setLightsailForTests(undefined); setRateFetcherForTests(undefined) })

  /** Ticks until the job leaves `step` (or gives up). */
  async function tickUntil(id: number, done: (j: ServerJob) => boolean, max = 20) {
    for (let i = 0; i < max && !done(getJob(id)!); i++) await tickProvision()
    return getJob(id)!
  }
  async function makeServer(name = 'Sydney 2', ramGb = 8) {
    const { job, error } = await startCreate({ name, ramGb, by: 'owner@example.com' })
    expect(error).toBeUndefined()
    let j = await tickUntil(job!.id, (x) => x.step === 'booting' || x.status !== 'running')
    expect(j.step).toBe('booting')
    const token = /Bearer ([^']+)'/.exec(ls.vms.get(j.lightsailName)!.userData)![1]
    expect(authorizeCallback(j.id, token, j.staticIp)).toMatchObject({ ok: true })
    const script = scriptFor(j, token)
    expect(script).toContain('setup-clubs-vm.sh')
    progressFrom(getJob(j.id)!, '==> Installing Docker')
    doneFrom(getJob(j.id)!, `ok\n${HOST_KEY}`)
    j = await tickUntil(j.id, (x) => x.status !== 'running')
    return { job: j, token }
  }

  it('lists what is missing before anything can be made', () => {
    saveSettings({ provisionGhcrToken: '' })
    expect(missingSetup().join(' ')).toMatch(/package token/)
  })

  it('makes a VM, gives it a static IP and ports, waits for its setup and adds the server', async () => {
    const { job, token } = await makeServer()
    expect(job.status).toBe('ready')
    expect(ls.calls).toEqual(expect.arrayContaining(['create avro-sydney-2', 'allocate avro-ip-sydney-2', 'attach avro-ip-sydney-2', 'ports avro-sydney-2']))
    expect(ls.vms.get('avro-sydney-2')!.tags['avro-managed']).toBe('yes')
    expect(ls.ports.get('avro-sydney-2')![0].cidrs).toEqual(['192.0.2.10/32'])
    expect(job.log).toMatch(/Installing Docker/)
    const server = getServer(job.serverId!)!
    expect(server).toMatchObject({ name: 'Sydney 2', host: job.staticIp, host_key: HOST_KEY, lightsail_name: 'avro-sydney-2', purpose: 'sites', max_clubs: 10, memory_mb: 8192, username: 'deployer' })
    // The one-time code is spent once the VM is done.
    expect(authorizeCallback(job.id, token, job.staticIp)).toMatchObject({ ok: false })
  })

  it('refuses callbacks without the code or from another address', async () => {
    const { job } = await startCreate({ name: 'Sydney 3', ramGb: 2, by: 'o' })
    const j = await tickUntil(job!.id, (x) => x.step === 'booting')
    const token = /Bearer ([^']+)'/.exec(ls.vms.get(j.lightsailName)!.userData)![1]
    expect(authorizeCallback(j.id, 'wrong', j.staticIp)).toEqual({ ok: false, status: 404 })
    expect(authorizeCallback(j.id, token, '8.8.8.8')).toEqual({ ok: false, status: 403 })
    expect(authorizeCallback(j.id + 99, token, j.staticIp)).toEqual({ ok: false, status: 404 })
  })

  it('keeps 1 GB servers for apps', async () => {
    const { job } = await makeServer('Tiny app', 1)
    const server = getServer(job.serverId!)!
    expect(server).toMatchObject({ purpose: 'apps', max_clubs: 1, memory_mb: 1024 })
    expect(pickServer()).toBeNull()
    expect(pickServer({ forApps: true })?.id).toBe(server.id)
    expect(serverRoomError(server, { memoryMb: 700, site: true })).toMatch(/memory/)
    expect(serverRoomError(server, { memoryMb: 256, site: true })).toBeNull()
  })

  it('stops at the server limit and over the budget unless told to go over', async () => {
    db().prepare('INSERT INTO cost_snapshots (fetched_at, ok, data) VALUES (?, 1, ?)').run(new Date().toISOString(), JSON.stringify({
      fetchedAt: new Date().toISOString(), raw: { monthly: [], daily: [], lightsail: [], forecastRest: 0, currency: 'USD' },
      resources: [{ kind: 'instance', name: 'sites', plan: '8 GB', monthlyUsd: 44, publicIp: '', privateIp: '', state: 'running' }], rate: 1.5, rateSource: 'typed', rateDate: '',
    }))
    saveSettings({ costBudget: 100 })
    const over = await startCreate({ name: 'Big', ramGb: 8, by: 'o' })
    expect(over.error).toMatch(/over the A\$100.00 budget/)
    expect((await startCreate({ name: 'Big', ramGb: 8, overBudget: true, by: 'o' })).job).toBeTruthy()
    saveSettings({ provisionMaxServers: 1 })
    expect((await startCreate({ name: 'Another', ramGb: 2, overBudget: true, by: 'o' })).error).toMatch(/limit is 1/)
  })

  it('fails a VM that never reports back, and discards it', async () => {
    const { job } = await startCreate({ name: 'Slow', ramGb: 2, by: 'o' })
    await tickUntil(job!.id, (x) => x.step === 'booting')
    db().prepare('UPDATE server_jobs SET deadline = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), job!.id)
    await tickProvision()
    expect(getJob(job!.id)!.status).toBe('failed')
    expect(retryJob(job!.id, 'o')).toMatch(/can't be run again/)
    expect(discardJob(job!.id, 'o')).toBeNull()
    const j = await tickUntil(job!.id, (x) => x.status !== 'running')
    expect(j.status).toBe('discarded')
    expect(ls.vms.has('avro-slow')).toBe(false)
    expect(ls.ips.has('avro-ip-slow')).toBe(false)
    expect(listServers()).toHaveLength(0)
  })

  it('fails when the setup on the VM fails, with its last lines', async () => {
    const { job } = await startCreate({ name: 'Broken', ramGb: 2, by: 'o' })
    const j = await tickUntil(job!.id, (x) => x.step === 'booting')
    doneFrom(j, 'failed\n!! apt is locked')
    expect(getJob(j.id)).toMatchObject({ status: 'failed' })
    expect(getJob(j.id)!.log).toMatch(/apt is locked/)
  })

  it('deletes only an empty server it made: snapshot first, then the VM and its IP', async () => {
    const { job } = await makeServer('Old', 2)
    const server = getServer(job.serverId!)!
    const club = insertClub({ name: 'club-a', displayName: 'A', serverId: server.id, status: 'running', image: 'x', modules: [], customDomains: [], secrets: {}, extraEnv: '', timezone: 'Australia/Sydney', memoryMb: 700, ownerEmail: '', ownerName: '', notes: '' })
    expect(startDelete(server.id, 'o').error).toMatch(/Move or remove/)
    db().prepare('DELETE FROM clubs WHERE id = ?').run(club.id)
    db().prepare('DELETE FROM projects WHERE server_id = ?').run(server.id)
    const del = startDelete(server.id, 'o')
    expect(del.error).toBeUndefined()
    expect(getServer(server.id)!.accepts_new).toBe(0)
    const d = await tickUntil(del.job!.id, (x) => x.status !== 'running')
    expect(d.status).toBe('ready')
    expect(ls.calls.indexOf('snapshot avro-old')).toBeLessThan(ls.calls.indexOf('delete avro-old'))
    expect(ls.vms.has('avro-old')).toBe(false)
    expect(ls.ips.has('avro-ip-old')).toBe(false)
    expect(getServer(server.id)).toBeNull()
    expect(listSnapshots()[0].snapshotName).toMatch(/^avro-old-final-\d{8}$/)

    // Daily: the snapshot goes after 14 days; a tagged VM nobody knows is flagged.
    ls.vms.set('avro-stray', { name: 'avro-stray', state: 'running', publicIp: '', isStaticIp: false, tags: { 'avro-managed': 'yes' }, userData: '', bundleId: 'x', polls: 0 })
    const check = await dailyCheck(new Date(Date.now() + 15 * 86_400_000))
    expect(check?.unknown).toEqual(['avro-stray'])
    expect(listSnapshots()).toHaveLength(0)
  })

  it('never deletes a server it did not make', () => {
    saveSettings({})
    const id = db().prepare("INSERT INTO servers (name, host, host_key, created_at) VALUES ('Manual', '1.2.3.4', 'x', ?)").run(new Date().toISOString()).lastInsertRowid
    expect(startDelete(Number(id), 'o').error).toMatch(/didn't make this server/)
  })

  it('ships the agent files the setup needs', () => {
    const names = agentFiles().map((f) => f.path)
    expect(names).toEqual(expect.arrayContaining(['setup-clubs-vm.sh', 'clubctl', 'clubctl-ssh', 'files/Caddyfile']))
  })
})

import {
  AllocateStaticIpCommand, AttachStaticIpCommand, CreateInstanceSnapshotCommand, CreateInstancesCommand, DeleteInstanceCommand,
  DeleteInstanceSnapshotCommand, GetBundlesCommand, GetInstanceCommand, GetInstanceSnapshotCommand, GetInstancesCommand,
  GetStaticIpCommand, LightsailClient, PutInstancePublicPortsCommand, ReleaseStaticIpCommand,
} from '@aws-sdk/client-lightsail'
import { isFakeEngine } from '@/lib/engine'
import { getSettings } from '@/lib/settings'
import { MANAGED_TAG, type Bundle, type PortRule } from './plan'

// The only code that makes, changes or deletes Lightsail VMs. Every VM it
// makes is tagged avro-managed=yes, and the AWS key's policy only lets it
// change or delete VMs with that tag.

export type Instance = { name: string; state: string; publicIp: string; isStaticIp: boolean; tags: Record<string, string> }
export type BundleInfo = Bundle & { active: boolean; linux: boolean }

export interface LightsailApi {
  bundles(): Promise<BundleInfo[]>
  createInstance(o: { name: string; zone: string; bundleId: string; userData: string; tags: Record<string, string> }): Promise<void>
  /** Null when there's no such VM. */
  getInstance(name: string): Promise<Instance | null>
  /** Every VM tagged avro-managed=yes. */
  managedInstances(): Promise<Instance[]>
  /** Makes the static IP if it doesn't exist yet; returns its address once attached. */
  allocateStaticIp(name: string): Promise<void>
  attachStaticIp(ipName: string, instanceName: string): Promise<void>
  getStaticIp(name: string): Promise<{ ip: string; attachedTo: string } | null>
  releaseStaticIp(name: string): Promise<void>
  setPorts(instanceName: string, rules: PortRule[]): Promise<void>
  createSnapshot(instanceName: string, snapshotName: string, tags: Record<string, string>): Promise<void>
  /** 'pending' | 'available' | 'error', or null when there's no such snapshot. */
  snapshotState(name: string): Promise<string | null>
  deleteSnapshot(name: string): Promise<void>
  deleteInstance(name: string): Promise<void>
}

const notFound = (err: unknown) => /NotFound|DoesNotExist/i.test((err as Error)?.name ?? '') || /does not exist|not found/i.test((err as Error)?.message ?? '')
const tagList = (t: Record<string, string>) => Object.entries(t).map(([key, value]) => ({ key, value }))
const tagMap = (t?: { key?: string; value?: string }[]) => Object.fromEntries((t ?? []).map((x) => [x.key ?? '', x.value ?? '']))

export class AwsLightsail implements LightsailApi {
  private ls: LightsailClient
  constructor(accessKeyId: string, secretAccessKey: string, region: string) {
    this.ls = new LightsailClient({ region, credentials: { accessKeyId, secretAccessKey } })
  }

  async bundles(): Promise<BundleInfo[]> {
    const out = await this.ls.send(new GetBundlesCommand({ includeInactive: false }))
    return (out.bundles ?? []).map((b) => ({
      bundleId: b.bundleId ?? '', ramGb: b.ramSizeInGb ?? 0, cpus: b.cpuCount ?? 0, diskGb: b.diskSizeInGb ?? 0,
      transferGb: b.transferPerMonthInGb ?? 0, priceUsd: b.price ?? 0, active: b.isActive !== false,
      linux: (b.supportedPlatforms ?? ['LINUX_UNIX']).includes('LINUX_UNIX'),
    }))
  }

  async createInstance(o: { name: string; zone: string; bundleId: string; userData: string; tags: Record<string, string> }) {
    await this.ls.send(new CreateInstancesCommand({
      instanceNames: [o.name], availabilityZone: o.zone, blueprintId: 'ubuntu_24_04', bundleId: o.bundleId,
      userData: o.userData, tags: tagList({ ...o.tags, [MANAGED_TAG]: 'yes' }),
    }))
  }

  async getInstance(name: string): Promise<Instance | null> {
    try {
      const i = (await this.ls.send(new GetInstanceCommand({ instanceName: name }))).instance
      return i ? { name: i.name ?? name, state: i.state?.name ?? '', publicIp: i.publicIpAddress ?? '', isStaticIp: !!i.isStaticIp, tags: tagMap(i.tags) } : null
    } catch (err) {
      if (notFound(err)) return null
      throw err
    }
  }

  async managedInstances(): Promise<Instance[]> {
    const out: Instance[] = []
    let pageToken: string | undefined
    do {
      const page = await this.ls.send(new GetInstancesCommand({ pageToken }))
      for (const i of page.instances ?? []) {
        const tags = tagMap(i.tags)
        if (tags[MANAGED_TAG] === 'yes') out.push({ name: i.name ?? '', state: i.state?.name ?? '', publicIp: i.publicIpAddress ?? '', isStaticIp: !!i.isStaticIp, tags })
      }
      pageToken = page.nextPageToken
    } while (pageToken)
    return out
  }

  async allocateStaticIp(name: string) {
    if (await this.getStaticIp(name)) return
    await this.ls.send(new AllocateStaticIpCommand({ staticIpName: name }))
  }
  async attachStaticIp(ipName: string, instanceName: string) {
    await this.ls.send(new AttachStaticIpCommand({ staticIpName: ipName, instanceName }))
  }
  async getStaticIp(name: string) {
    try {
      const ip = (await this.ls.send(new GetStaticIpCommand({ staticIpName: name }))).staticIp
      return ip ? { ip: ip.ipAddress ?? '', attachedTo: ip.isAttached ? ip.attachedTo ?? '' : '' } : null
    } catch (err) {
      if (notFound(err)) return null
      throw err
    }
  }
  async releaseStaticIp(name: string) {
    if (!name.startsWith('avro-ip-')) throw new Error(`Refusing to release a static IP the deployer didn't make: ${name}`)
    try { await this.ls.send(new ReleaseStaticIpCommand({ staticIpName: name })) } catch (err) { if (!notFound(err)) throw err }
  }

  async setPorts(instanceName: string, rules: PortRule[]) {
    await this.ls.send(new PutInstancePublicPortsCommand({ instanceName, portInfos: rules }))
  }

  async createSnapshot(instanceName: string, snapshotName: string, tags: Record<string, string>) {
    await this.ls.send(new CreateInstanceSnapshotCommand({ instanceName, instanceSnapshotName: snapshotName, tags: tagList({ ...tags, [MANAGED_TAG]: 'yes' }) }))
  }
  async snapshotState(name: string) {
    try {
      const s = (await this.ls.send(new GetInstanceSnapshotCommand({ instanceSnapshotName: name }))).instanceSnapshot
      return s ? String(s.state ?? 'pending') : null
    } catch (err) {
      if (notFound(err)) return null
      throw err
    }
  }
  async deleteSnapshot(name: string) {
    try { await this.ls.send(new DeleteInstanceSnapshotCommand({ instanceSnapshotName: name })) } catch (err) { if (!notFound(err)) throw err }
  }
  async deleteInstance(name: string) {
    const i = await this.getInstance(name)
    if (!i) return
    if (i.tags[MANAGED_TAG] !== 'yes') throw new Error(`Refusing to delete ${name}: it isn't tagged as made by the deployer.`)
    await this.ls.send(new DeleteInstanceCommand({ instanceName: name, forceDeleteAddOns: true }))
  }
}

// ── Simulated Lightsail for local development and tests ──────────────────────

type FakeVm = Instance & { userData: string; bundleId: string; polls: number }
export class FakeLightsail implements LightsailApi {
  vms = new Map<string, FakeVm>()
  ips = new Map<string, { ip: string; attachedTo: string }>()
  snapshots = new Map<string, { state: string; polls: number }>()
  ports = new Map<string, PortRule[]>()
  calls: string[] = []
  /** Polls before a new VM shows as running. */
  bootPolls = 1
  private nextIp = 10

  async bundles(): Promise<BundleInfo[]> {
    const b = (id: string, ramGb: number, cpus: number, diskGb: number, priceUsd: number): BundleInfo => ({ bundleId: id, ramGb, cpus, diskGb, transferGb: 1000 * Math.max(1, ramGb), priceUsd, active: true, linux: true })
    return [
      b('nano_3_0', 0.5, 2, 20, 5), b('micro_3_0', 1, 2, 40, 7), b('micro_ipv6_3_0', 1, 2, 40, 5), b('small_3_0', 2, 2, 60, 12),
      b('medium_3_0', 4, 2, 80, 24), b('large_3_0', 8, 2, 160, 44), b('xlarge_3_0', 16, 4, 320, 84),
    ]
  }
  async createInstance(o: { name: string; zone: string; bundleId: string; userData: string; tags: Record<string, string> }) {
    this.calls.push(`create ${o.name}`)
    if (this.vms.has(o.name)) throw Object.assign(new Error(`Some names are already in use: ${o.name}`), { name: 'InvalidInputException' })
    this.vms.set(o.name, { name: o.name, state: 'pending', publicIp: '', isStaticIp: false, tags: { ...o.tags, [MANAGED_TAG]: 'yes' }, userData: o.userData, bundleId: o.bundleId, polls: 0 })
  }
  async getInstance(name: string) {
    const vm = this.vms.get(name)
    if (!vm) return null
    if (vm.state === 'pending' && ++vm.polls > this.bootPolls) { vm.state = 'running'; vm.publicIp = `198.51.100.${this.nextIp++}` }
    return { name: vm.name, state: vm.state, publicIp: vm.publicIp, isStaticIp: vm.isStaticIp, tags: vm.tags }
  }
  async managedInstances() { return [...this.vms.values()].filter((v) => v.tags[MANAGED_TAG] === 'yes').map(({ name, state, publicIp, isStaticIp, tags }) => ({ name, state, publicIp, isStaticIp, tags })) }
  async allocateStaticIp(name: string) { this.calls.push(`allocate ${name}`); if (!this.ips.has(name)) this.ips.set(name, { ip: `203.0.113.${this.nextIp++}`, attachedTo: '' }) }
  async attachStaticIp(ipName: string, instanceName: string) {
    this.calls.push(`attach ${ipName}`)
    const ip = this.ips.get(ipName); const vm = this.vms.get(instanceName)
    if (!ip || !vm) throw Object.assign(new Error('not found'), { name: 'NotFoundException' })
    ip.attachedTo = instanceName; vm.publicIp = ip.ip; vm.isStaticIp = true
  }
  async getStaticIp(name: string) { return this.ips.get(name) ?? null }
  async releaseStaticIp(name: string) { this.calls.push(`release ${name}`); this.ips.delete(name) }
  async setPorts(instanceName: string, rules: PortRule[]) { this.calls.push(`ports ${instanceName}`); this.ports.set(instanceName, rules) }
  async createSnapshot(instanceName: string, snapshotName: string) { this.calls.push(`snapshot ${instanceName}`); this.snapshots.set(snapshotName, { state: 'pending', polls: 0 }) }
  async snapshotState(name: string) {
    const s = this.snapshots.get(name)
    if (!s) return null
    if (s.state === 'pending' && ++s.polls > 1) s.state = 'available'
    return s.state
  }
  async deleteSnapshot(name: string) { this.calls.push(`delete-snapshot ${name}`); this.snapshots.delete(name) }
  async deleteInstance(name: string) {
    this.calls.push(`delete ${name}`)
    const vm = this.vms.get(name)
    if (vm && vm.tags[MANAGED_TAG] !== 'yes') throw new Error(`Refusing to delete ${name}`)
    this.vms.delete(name)
    for (const ip of this.ips.values()) if (ip.attachedTo === name) ip.attachedTo = ''
  }
}

const g = globalThis as unknown as { __lightsailForTests?: LightsailApi; __fakeLightsail?: FakeLightsail }
export function setLightsailForTests(api: LightsailApi | undefined) { g.__lightsailForTests = api }
export const fakeLightsail = () => (g.__fakeLightsail ??= new FakeLightsail())

/** The configured Lightsail, or null when no "new servers" key is saved. */
export function lightsail(): LightsailApi | null {
  if (g.__lightsailForTests) return g.__lightsailForTests
  const s = getSettings()
  if (s.provisionAccessKeyId && s.provisionSecretAccessKey) return new AwsLightsail(s.provisionAccessKeyId, s.provisionSecretAccessKey, s.provisionRegion || 'ap-southeast-2')
  if (isFakeEngine()) return fakeLightsail()
  return null
}

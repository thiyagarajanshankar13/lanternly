'use server'

import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit'
import { pluginOffError, requireOwner } from '@/lib/guards'
import { getServer } from '@/lib/clubs'
import { getSettings, saveSettings } from '@/lib/settings'
import { isEmail } from '@/lib/validate'
import { isIpv4 } from '@/plugins/aws/provision/plan'
import { dailyCheck, discardJob, getJob, clearPriceCache, retryJob, startCreate, startDelete } from '@/plugins/aws/provision/jobs'
import { lightsail } from '@/plugins/aws/provision/lightsail'
import { awsErrorText } from '@/plugins/aws/costs/aws'

// The AWS plugin's actions on the Servers page: servers the deployer makes in
// Lightsail. Owners only (requireOwner on every action).

type FormState = { error?: string; ok?: string } | undefined
const str = (form: FormData, key: string) => String(form.get(key) ?? '').trim()

export async function saveProvisionSettingsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const off = pluginOffError('aws')
  if (off) return { error: off }
  const id = str(form, 'provisionAccessKeyId')
  const secret = str(form, 'provisionSecretAccessKey')
  const region = str(form, 'provisionRegion') || 'ap-southeast-2'
  const zone = str(form, 'provisionZone') || `${region}a`
  const ip = str(form, 'provisionDeployerIp')
  const email = str(form, 'provisionAcmeEmail')
  const ghcrUser = str(form, 'provisionGhcrUser')
  const ghcrToken = str(form, 'provisionGhcrToken')
  const max = Number(str(form, 'provisionMaxServers') || '5')
  if (id && !/^(AKIA|ASIA)[A-Z0-9]{12,20}$/.test(id)) return { error: 'An access key ID starts with AKIA and has 16 to 24 capital letters and digits.' }
  if (id && id === getSettings().costAccessKeyId) return { error: 'Use a separate key from the costs key: this one can make and delete VMs.' }
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) return { error: 'The region looks like ap-southeast-2 (Sydney).' }
  if (!zone.startsWith(region) || !/^[a-z]{2}-[a-z]+-\d[a-z]$/.test(zone)) return { error: `The zone is the region plus a letter, like ${region}a.` }
  if (ip && !isIpv4(ip)) return { error: 'The deployer\'s IP is an IPv4 address like 13.54.1.2, or empty to look it up.' }
  if (email && !isEmail(email)) return { error: 'The certificate email should be an email address.' }
  if (ghcrUser && !/^[A-Za-z0-9-]{1,39}$/.test(ghcrUser)) return { error: 'The GitHub user is a GitHub login, like my-deploy-bot.' }
  if (!(Number.isInteger(max) && max >= 1 && max <= 50)) return { error: 'The most servers is a number from 1 to 50.' }
  saveSettings({
    provisionAccessKeyId: id, provisionRegion: region, provisionZone: zone, provisionDeployerIp: ip, provisionAcmeEmail: email,
    provisionGhcrUser: ghcrUser, provisionMaxServers: max,
    ...(secret ? { provisionSecretAccessKey: secret } : {}), ...(!id ? { provisionSecretAccessKey: '' } : {}),
    ...(ghcrToken ? { provisionGhcrToken: ghcrToken } : {}),
  })
  clearPriceCache()
  await audit(admin, 'server', { detail: `Settings for new servers saved${secret ? ' (new AWS secret)' : ''}${ghcrToken ? ' (new package token)' : ''}${!id && getSettings().provisionAccessKeyId === '' ? ', no AWS key' : ''}` })
  revalidatePath('/admin/servers')
  if (!id) return { ok: 'Saved. Without an AWS key the deployer can\'t make servers.' }
  try {
    const sizes = await lightsail()!.bundles()
    return { ok: `Saved. Lightsail answered with ${sizes.length} plans.` }
  } catch (err) {
    return { error: `Saved, but Lightsail refused the key: ${awsErrorText(err)}` }
  }
}

export async function createServerAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const off = pluginOffError('aws')
  if (off) return { error: off }
  const ramGb = Number(str(form, 'ramGb'))
  const maxClubs = str(form, 'maxClubs') ? Number(str(form, 'maxClubs')) : undefined
  if (maxClubs !== undefined && !(Number.isInteger(maxClubs) && maxClubs >= 1 && maxClubs <= 500)) return { error: 'Most sites is a number from 1 to 500, or empty for the size\'s usual number.' }
  const { job, error } = await startCreate({ name: str(form, 'name'), ramGb, maxClubs, overBudget: form.get('overBudget') === 'on', by: admin.email })
  if (error || !job) return { error }
  await audit(admin, 'server-create', { detail: `${job.name} (${job.lightsailName}), ${job.ramGb} GB, US$${job.priceUsd}/month` })
  revalidatePath('/admin/servers')
  return { ok: `Making ${job.name}. It takes about 10 minutes; follow it on this page.` }
}

export async function deleteManagedServerAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const server = getServer(Number(str(form, 'id')))
  if (!server) return { error: 'No such server.' }
  if (str(form, 'confirm') !== server.name) return { error: `Type ${server.name} to confirm.` }
  const { job, error } = startDelete(server.id, admin.email)
  if (error || !job) return { error }
  await audit(admin, 'server-delete', { detail: `${server.name} (${server.lightsail_name}); snapshot ${job.snapshotName}` })
  revalidatePath('/admin/servers')
  return { ok: `Deleting ${server.name}. A snapshot is taken first.` }
}

export async function retryServerJobAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const error = retryJob(Number(str(form, 'id')), admin.email)
  revalidatePath('/admin/servers')
  return error ? { error } : { ok: 'Trying again.' }
}

export async function discardServerJobAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await requireOwner()
  const job = getJob(Number(str(form, 'id')))
  const error = discardJob(Number(str(form, 'id')), admin.email)
  if (!error && job) await audit(admin, 'server-delete', { detail: `Discarded the half-made ${job.name} (${job.lightsailName})` })
  revalidatePath('/admin/servers')
  return error ? { error } : { ok: 'Deleting what was made in Lightsail.' }
}

export async function checkLightsailAction(_prev: FormState): Promise<FormState> {
  await requireOwner()
  const off = pluginOffError('aws')
  if (off) return { error: off }
  const r = await dailyCheck()
  revalidatePath('/admin/servers')
  if (!r) return { error: 'Add the AWS key for new servers first.' }
  if (r.error) return { error: r.error }
  return { ok: r.unknown.length ? `${r.unknown.length} VM${r.unknown.length === 1 ? '' : 's'} tagged as the deployer's that it doesn't know: ${r.unknown.join(', ')}.` : 'Every Lightsail VM the deployer made is one of its servers.' }
}
